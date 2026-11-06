// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title PrivacyPoolLogic (Nainokot privacy pool, chain 1337 experiment)
/// @notice msp d0b2131's ShieldedPoolLogic for a separate privacy pool whose notes pay the gas of
/// any transaction the user's own account sends. Changes from msp: settle (pool as sender, with
/// nullifiers as EIP-8250 nonce keys) is replaced by settleSponsored (the last frame of a
/// sponsored transaction, nullifiers kept in storage), plus stake(). The state lives in
/// PrivacyPoolDispatcher.yul's storage, which delegatecalls everything but its frame entries.
/// @dev The dispatcher checks a spend's proof and whole frame transaction before approving
/// it, and approval consumes the spend's nullifiers. A settlement that then fails burns the
/// notes, so every refusal in settle is also made before approval (see settle).
contract PrivacyPoolLogic {
    /// @notice The depth of each epoch's Merkle tree, as in the circuit.
    uint32 public constant DEPTH = 20;
    uint32 public constant CAPACITY = uint32(1) << DEPTH;
    /// @dev BN254's scalar field order p, the circuit's field.
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev Amounts are below 2^128, the circuit's range check.
    uint256 internal constant MAX_VALUE = 1 << 128;
    /// @notice The root of the empty depth-20 tree, _zeros(DEPTH).
    bytes32 public constant EMPTY_ROOT = 0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e;
    /// @notice keccak256("minimal-shielded-pool:occurrence-domain:v1"), the first word of
    /// every nullifier domain.
    bytes32 public constant DOMAIN_TAG = 0xa9d03fa1cd97bcf3294dc8e3bb024f555393c98967b356967fa502abab366ed3;
    /// @notice The first output's sink, Poseidon(2, 1, 0): the commitment a zero-value first
    /// output must have. Settlement does not insert sinks.
    bytes32 public constant SINK_0 = 0x23f1b896ada6ee5dac80945b11329e7ab64412c2be9f5c87cfa3261cc1d8216f;
    /// @notice The second output's sink, Poseidon(2, 2, 0).
    bytes32 public constant SINK_1 = 0x2fd476622c67c880b3049a76c7337192362834c9d6dfb55c5060bb96c98932bb;
    /// @notice EIP-8272's RECENT_ROOT_ADDRESS, which publishEpochRoot writes to.
    address public constant RECENT_ROOT_PREDEPLOY = address(0x8272);
    /// @notice A note is a 16-byte tag, a 16-byte encrypted amount and a 16-byte
    /// authentication tag. The pool publishes notes and never reads them: a wrong note only
    /// stops the recipient from finding its payment.
    uint256 public constant NOTE_BYTES = 48;
    /// @notice The length of the ML-KEM-768 ciphertext that a sender's first payment to a
    /// public address puts before its notes.
    uint256 public constant KEM_CIPHERTEXT_BYTES = 1088;
    /// @dev settle(Spend) calldata is the selector and twelve words; the notes follow.
    uint256 internal constant SETTLE_SPEND_BYTES = 4 + 12 * 32;

    /// @dev Refund notes. A settle frame whose data ends with one more word, the refund note's
    /// inner = Poseidon(owner_pk, rho), gets back as a note what the proof's fee overpays: the fee
    /// less an upper bound of what the transaction will be charged, priced at tx.gasprice. The
    /// bound is what the dispatcher's gasMeter() reports (intrinsic gas and every finished frame's
    /// use, the calldata floor's upper bound, this frame's use so far) plus a reserve for the work
    /// left after it is measured. An underestimate would pay out ETH the pool never got back, so
    /// every term rounds up. HASH_CALL_GAS covers one Poseidon call with its checks;
    /// REFUND_TAIL_GAS the events, the storage writes' execution part and the return path.
    uint256 internal constant HASH_CALL_GAS = 33_000;
    uint256 internal constant REFUND_TAIL_GAS = 60_000;
    uint256 internal constant NEW_SLOT_STATE_GAS = 97_920;
    /// @dev The dispatcher's gasMeter() (cast sig "gasMeter()").
    bytes4 internal constant GAS_METER = 0x43f97ae5;

    address private immutable IMPLEMENTATION_SELF = address(this);
    address public immutable POSEIDON_T3;
    address public immutable POSEIDON_T4;

    // The dispatcher's constructor writes EMPTY_ROOT to slot 22, so these slots must not move.
    /// @notice The current tree's filled left subtrees by height (see _insert).
    bytes32[DEPTH + 1] public filledSubtrees; // slots 0..20
    /// @notice The number of leaves in the current tree, which is the next leaf's index.
    uint32 public nextIndex; // slot 21
    bytes32 public currentRoot; // slot 22
    /// @notice The ETH settlement owes each recipient, which claimWithdrawal pays out.
    mapping(address => uint256) public withdrawalCredit; // slot 23
    /// @notice The epoch whose tree takes new leaves.
    uint64 public currentEpoch; // slot 24
    /// @notice Each closed epoch's root, from when it closed.
    mapping(uint64 => bytes32) public finalRoot; // slot 25
    /// @notice Spent nullifiers. PrivacyPoolDispatcher.yul reads and writes this mapping directly
    /// (slot keccak256(nf || 26)), so it must stay at slot 26.
    mapping(bytes32 => bool) public nullifierSpent; // slot 26

    /// @dev settle's argument. The proof covers ten fields, in the statement order nf1, nf2,
    /// outCm1, outCm2, root, domain, publicAmount, fee, recipient, authorizer. rootSlot and
    /// epoch name the recent-root tuple, and the domain takes the same epoch.
    struct Spend {
        bytes32 root;
        uint64 rootSlot;
        uint64 epoch;
        bytes32 domain;
        bytes32 nf1;
        bytes32 nf2;
        bytes32 outCm1;
        bytes32 outCm2;
        uint256 publicAmount;
        uint256 fee;
        address recipient;
        address authorizer;
    }

    /// @notice A commitment was appended to the current epoch's tree.
    /// @param index Its leaf index in that tree, which its nullifier binds.
    /// @param newRoot The tree's root after every leaf this call appends, so both outputs of
    /// one settlement carry the same root.
    event LeafAppended(bytes32 indexed cm, uint64 indexed epoch, uint32 index, bytes32 newRoot);
    /// @notice A settled spend's nullifier, which approval consumed as an EIP-8250 nonce key.
    /// Wallets track their spends by it.
    event NoteSpent(bytes32 indexed nf);
    /// @notice A refund note: cm holds value, the fee less chargedGas at the gas price.
    event RefundNote(bytes32 indexed cm, uint256 value, uint256 chargedGas);
    /// @notice The tree lacked room, so the pool closed an epoch and started an empty tree.
    /// @param finalRoot The closed epoch's root, which spends of its notes keep proving against.
    event EpochRolled(uint64 indexed closedEpoch, bytes32 finalRoot, uint64 indexed newEpoch);
    /// @notice The pool wrote an epoch's root to EIP-8272.
    event RootPublished(uint64 indexed epoch, bytes32 indexed source, bytes32 root);
    /// @notice A settlement credited a withdrawal, which claimWithdrawal pays out.
    event WithdrawalCredited(address indexed recipient, uint256 amount);
    /// @notice claimWithdrawal paid a recipient its whole credit.
    event Withdrawn(address indexed recipient, uint256 amount);
    /// @notice The encrypted notes a shield or settlement carries, as sent.
    /// @param notes One note for a shield or two for a settlement, optionally after an
    /// ML-KEM-768 ciphertext.
    event Notes(bytes notes);

    error DirectImplementationCall();
    error ZeroValueShield();
    /// @notice An amount is 2^128 or more, which no proof can spend.
    error ValueTooLarge();
    /// @notice A shield's commitment is a sink. A shield's value is never zero, so only a
    /// Poseidon collision reaches this.
    error ReservedSink();
    /// @notice A value that must be a field element is p or more.
    error NotCanonical();
    error NotPoolSender();
    error ZeroNullifier();
    /// @notice A spend's domain is not domain(epoch).
    error InvalidDomain();
    /// @notice The epoch is after the current one.
    error InvalidEpoch();
    error InvalidAuthorizer();
    /// @notice A spend names a recipient without a withdrawal or a withdrawal without a
    /// recipient, has two equal outputs, or has a sink in the other output's position.
    error InvalidSettlementShape();
    /// @notice The epoch has no root, which happens only if the pool's deployment did not
    /// store EMPTY_ROOT.
    error InvalidRoot();
    error RootPublishFailed();
    error NoCredit();
    /// @notice The ETH transfer to the recipient failed, so the credit stays.
    error PayoutFailed();
    error InvalidHashLibrary();
    /// @notice A Poseidon call failed or did not return one field element.
    error HashFailed();
    error InvalidNotes();
    error StakeFailed();
    error GasMeterFailed();

    /// @dev Refuses a call to the implementation itself, whose own storage is not the pool's.
    /// A direct shield, for one, would lock its ETH in the implementation.
    modifier onlyDelegate() {
        if (address(this) == IMPLEMENTATION_SELF) revert DirectImplementationCall();
        _;
    }

    /// @dev The dispatcher's constructor, not this one, stores EMPTY_ROOT in slot 22.
    constructor(address poseidonT3, address poseidonT4) {
        if (poseidonT3.code.length == 0 || poseidonT4.code.length == 0) revert InvalidHashLibrary();
        POSEIDON_T3 = poseidonT3;
        POSEIDON_T4 = poseidonT4;
    }

    /// @notice The EIP-8272 source_id that publishEpochRoot(epoch) writes under,
    /// keccak256(pool || bytes32(epoch)), where the pool is this contract's address.
    function sourceId(uint64 epoch) public view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), bytes32(uint256(epoch))));
    }

    /// @notice The nullifier domain of an epoch of this pool on this chain.
    /// @param epoch The epoch of the root a spend proves against.
    function domain(uint64 epoch) public view returns (bytes32) {
        return domainFor(block.chainid, address(this), epoch);
    }

    /// @notice keccak256(DOMAIN_TAG || chainId || pool || epoch) mod p, over 32-byte words.
    /// The domain keeps nullifiers of different chains, pools and epochs apart. Leaf
    /// indices restart with each epoch, so without the epoch, equal commitments at the same
    /// index of two epochs would share a nullifier.
    /// @param epoch The epoch of the root a spend proves against.
    function domainFor(uint256 chainId, address pool, uint64 epoch) public pure returns (bytes32) {
        return bytes32(
            uint256(keccak256(abi.encodePacked(DOMAIN_TAG, chainId, bytes32(uint256(uint160(pool))), uint256(epoch))))
                % P
        );
    }

    /// @notice Deposits msg.value as a note: appends Poseidon(2, inner, msg.value) to the
    /// current tree and emits the note. Anyone may call it.
    /// @dev The commitment takes its value from msg.value, so a note never holds more than
    /// was paid in. A full tree starts a new epoch first.
    /// @param inner The recipient's Poseidon(owner_pk, rho), below p.
    /// @param note One note, optionally after an ML-KEM-768 ciphertext. Only its length is
    /// checked.
    /// @return index The new leaf's index in the current epoch's tree.
    function shield(bytes32 inner, bytes calldata note) external payable onlyDelegate returns (uint32 index) {
        if (msg.value == 0) revert ZeroValueShield();
        if (msg.value >= MAX_VALUE) revert ValueTooLarge();
        if (uint256(inner) >= P) revert NotCanonical();
        if (note.length != NOTE_BYTES && note.length != KEM_CIPHERTEXT_BYTES + NOTE_BYTES) revert InvalidNotes();

        bytes32 cm = bytes32(_hash3(2, uint256(inner), msg.value));
        if (cm == SINK_0 || cm == SINK_1) revert ReservedSink();

        _ensureCapacity(1);
        index = _insert(cm);
        currentRoot = _computeRoot();
        emit LeafAppended(cm, currentEpoch, index, currentRoot);
        emit Notes(note);
    }

    /// @notice Settles a sponsored spend: marks both nullifiers spent, appends its outputs other
    /// than sinks, credits any withdrawal and emits its notes. It runs only as the last frame of a
    /// sponsored frame transaction: the dispatcher intercepts this selector and checks, before
    /// delegating here, that this is that frame and that the pool's own validation frame (pay, or
    /// pre_verify then pay) approved this exact statement in this transaction.
    /// @dev Every refusal below was made before payment was approved, so this cannot fail once the
    /// pool has paid. In the pre_verify shape the nullifiers are already marked by the pre_verify
    /// frame, so marking them again is a no-op.
    function settleSponsored(Spend calldata s) external onlyDelegate {
        uint256 notesLength = msg.data.length - SETTLE_SPEND_BYTES;
        // One more word after the notes is the refund note's inner (refund mode).
        bool refund = notesLength == 2 * NOTE_BYTES + 32 || notesLength == KEM_CIPHERTEXT_BYTES + 2 * NOTE_BYTES + 32;
        if (refund) notesLength -= 32;
        if (notesLength != 2 * NOTE_BYTES && notesLength != KEM_CIPHERTEXT_BYTES + 2 * NOTE_BYTES) {
            revert InvalidNotes();
        }
        if (s.nf1 == bytes32(0) || s.nf2 == bytes32(0)) revert ZeroNullifier();
        if (s.authorizer == address(0)) revert InvalidAuthorizer();
        if (s.domain != domain(s.epoch)) revert InvalidDomain();
        if (s.epoch > currentEpoch) revert InvalidEpoch();
        if (
            uint256(s.root) >= P || uint256(s.domain) >= P || uint256(s.nf1) >= P || uint256(s.nf2) >= P
                || uint256(s.outCm1) >= P || uint256(s.outCm2) >= P
        ) revert NotCanonical();
        if (s.publicAmount >= MAX_VALUE || s.fee >= MAX_VALUE) revert ValueTooLarge();
        if ((s.publicAmount == 0) != (s.recipient == address(0))) revert InvalidSettlementShape();
        if (s.outCm1 == s.outCm2 || s.outCm1 == SINK_1 || s.outCm2 == SINK_0) {
            revert InvalidSettlementShape();
        }

        nullifierSpent[s.nf1] = true;
        nullifierSpent[s.nf2] = true;
        emit NoteSpent(s.nf1);
        emit NoteSpent(s.nf2);

        uint32 appendCount;
        if (s.outCm1 != SINK_0) appendCount++;
        if (s.outCm2 != SINK_1) appendCount++;
        if (refund) appendCount++;
        _ensureCapacity(appendCount);

        bool new1 = s.outCm1 != SINK_0;
        bool new2 = s.outCm2 != SINK_1;
        uint32 i1;
        uint32 i2;
        if (new1) i1 = _insert(s.outCm1);
        if (new2) i2 = _insert(s.outCm2);
        bytes32 refundCm;
        uint32 i3;
        uint256 refundValue;
        uint256 chargedGas;
        if (refund) (refundCm, refundValue, chargedGas) = _refundNote(s.fee);
        bool new3 = refundValue != 0;
        if (new3) i3 = _insert(refundCm);
        if (new1 || new2 || new3) {
            currentRoot = _computeRoot();
            if (new1) emit LeafAppended(s.outCm1, currentEpoch, i1, currentRoot);
            if (new2) emit LeafAppended(s.outCm2, currentEpoch, i2, currentRoot);
            if (new3) {
                emit LeafAppended(refundCm, currentEpoch, i3, currentRoot);
                emit RefundNote(refundCm, refundValue, chargedGas);
            }
        }

        if (s.publicAmount != 0) {
            withdrawalCredit[s.recipient] += s.publicAmount;
            emit WithdrawalCredited(s.recipient, s.publicAmount);
        }
        emit Notes(msg.data[SETTLE_SPEND_BYTES:SETTLE_SPEND_BYTES + notesLength]);
    }

    /// @dev The refund note for a fee of fee, its value 0 when nothing is left over. Measured
    /// after the change note's insertion, so what remains is this note's hash and insertion, the
    /// root, the events and the return: the reserve. The dispatcher refused the inner before
    /// payment unless it is a field element, and a refund value is never zero, so cm is no sink.
    function _refundNote(uint256 fee) internal returns (bytes32 cm, uint256 value, uint256 chargedGas) {
        (bool ok, bytes memory ret) = address(this).staticcall(abi.encodeWithSelector(GAS_METER));
        if (!ok || ret.length != 192) revert GasMeterFailed();
        (uint256 execBefore, uint256 stateBefore, uint256 floorTotal, uint256 execLimit, uint256 stateLimit,
            uint256 stateLeft) = abi.decode(ret, (uint256, uint256, uint256, uint256, uint256, uint256));
        uint256 left = gasleft();

        // The insertion hashes once per trailing one of the index and writes filledSubtrees at
        // that height; the root hashes DEPTH times; the commitment once.
        uint32 idx = nextIndex;
        uint256 height;
        while ((idx >> height) & 1 == 1) height++;
        uint256 reserveExec = REFUND_TAIL_GAS + (height + DEPTH + 1) * HASH_CALL_GAS;
        uint256 reserveState = filledSubtrees[height] == bytes32(0) ? NEW_SLOT_STATE_GAS : 0;
        if (idx == 0) reserveState += NEW_SLOT_STATE_GAS;

        uint256 exec = execBefore + (execLimit - left) + reserveExec;
        if (exec < floorTotal) exec = floorTotal;
        chargedGas = exec + stateBefore + (stateLimit - stateLeft) + reserveState;
        uint256 cost = chargedGas * tx.gasprice;
        if (cost >= fee) return (bytes32(0), 0, chargedGas);
        value = fee - cost;
        uint256 inner = uint256(bytes32(msg.data[msg.data.length - 32:]));
        cm = bytes32(_hash3(2, inner, value));
    }

    /// @notice Stakes msg.value for this pool in an ERC-8421 staking registry, which takes stake
    /// only from the staked entity itself. Anyone may add stake; this pool has no owner, so it
    /// never unlocks or withdraws it.
    function stake(address registry, uint32 unstakeDelaySec) external payable onlyDelegate {
        if (msg.value == 0) revert ZeroValueShield();
        (bool ok,) = registry.call{value: msg.value}(abi.encodeWithSignature("addStake(uint32)", unstakeDelaySec));
        if (!ok) revert StakeFailed();
    }

    /// @notice Writes an epoch's root to EIP-8272, so spends can prove against it. Anyone
    /// may call it: the root comes from pool state, never from the caller.
    /// @dev Settlement never publishes, so a failed publication cannot consume approved
    /// note keys without creating the promised outputs. EIP-8272 keeps only the last root
    /// a source writes in a slot, so a second publication of an epoch in one slot replaces
    /// the first.
    /// @param epoch The current epoch, whose root changes as leaves arrive, or a closed one.
    function publishEpochRoot(uint64 epoch) external onlyDelegate {
        bytes32 root;
        if (epoch == currentEpoch) root = currentRoot;
        else if (epoch < currentEpoch) root = finalRoot[epoch];
        else revert InvalidEpoch();
        if (root == bytes32(0)) revert InvalidRoot();

        bytes32 salt = bytes32(uint256(epoch));
        (bool ok,) = RECENT_ROOT_PREDEPLOY.call(abi.encodePacked(salt, root));
        if (!ok) revert RootPublishFailed();
        emit RootPublished(epoch, sourceId(epoch), root);
    }

    /// @notice Pays a recipient its whole withdrawal credit with a plain ETH call. Anyone
    /// may call it, and the ETH goes only to who.
    /// @dev The credit is zeroed before the call, so a recipient that reenters is paid once.
    /// A failed payout reverts the claim and keeps the credit for a later one.
    function claimWithdrawal(address payable who) external onlyDelegate {
        uint256 amount = withdrawalCredit[who];
        if (amount == 0) revert NoCredit();
        withdrawalCredit[who] = 0;
        emit Withdrawn(who, amount);
        (bool ok,) = who.call{value: amount}("");
        if (!ok) revert PayoutFailed();
    }

    /// @dev Starts a new epoch when the current tree lacks room for count leaves, so an
    /// insertion never fails for lack of room after approval.
    function _ensureCapacity(uint32 count) internal {
        if (count > CAPACITY - nextIndex) _rollEpoch();
    }

    function _rollEpoch() internal {
        uint64 closed = currentEpoch;
        bytes32 closedRoot = currentRoot;
        finalRoot[closed] = closedRoot;
        currentEpoch = closed + 1;
        nextIndex = 0;
        currentRoot = EMPTY_ROOT;
        for (uint32 l = 0; l <= DEPTH; l++) {
            delete filledSubtrees[l];
        }
        emit EpochRolled(closed, closedRoot, currentEpoch);
    }

    function _hashPair(bytes32 l, bytes32 r) internal view returns (bytes32) {
        return bytes32(_hash2(uint256(l), uint256(r)));
    }

    /// @dev Poseidon(x0, x1) from PoseidonT3.hash2 (selector 0x511c53ff). A failed call, a
    /// return other than one word, or an output of p or more reverts, so a faulty library
    /// cannot put a non-canonical node in the tree.
    function _hash2(uint256 x0, uint256 x1) internal view returns (uint256 out) {
        (bool ok, bytes memory ret) =
            POSEIDON_T3.staticcall{gas: 200_000}(abi.encodeWithSelector(bytes4(0x511c53ff), x0, x1));
        if (!ok || ret.length != 32) revert HashFailed();
        out = abi.decode(ret, (uint256));
        if (out >= P) revert HashFailed();
    }

    /// @dev Poseidon(x0, x1, x2) from PoseidonT4.hash3 (selector 0x2dbf86c6), checked as in
    /// _hash2.
    function _hash3(uint256 x0, uint256 x1, uint256 x2) internal view returns (uint256 out) {
        (bool ok, bytes memory ret) =
            POSEIDON_T4.staticcall{gas: 200_000}(abi.encodeWithSelector(bytes4(0x2dbf86c6), x0, x1, x2));
        if (!ok || ret.length != 32) revert HashFailed();
        out = abi.decode(ret, (uint256));
        if (out >= P) revert HashFailed();
    }

    /// @dev Appends cm at nextIndex. filledSubtrees[l] holds the root of the last complete
    /// left subtree of height l: while the new node is a right child, it is hashed with
    /// that subtree and carried up, and it is stored at the first height where it is a left
    /// child. The last leaf of a full tree carries all the way to filledSubtrees[DEPTH].
    function _insert(bytes32 cm) internal returns (uint32 index) {
        index = nextIndex;
        nextIndex = index + 1;
        bytes32 node = cm;
        uint32 idx = index;
        uint32 l;
        while (idx & 1 == 1) {
            node = _hashPair(filledSubtrees[l], node);
            idx >>= 1;
            l++;
        }
        filledSubtrees[l] = node;
    }

    /// @dev The current tree's root, with empty subtrees to the right of the last leaf. A
    /// full tree's root is filledSubtrees[DEPTH].
    function _computeRoot() internal view returns (bytes32 node) {
        uint32 idx = nextIndex;
        if (idx == CAPACITY) return filledSubtrees[DEPTH];
        for (uint32 l = 0; l < DEPTH; l++) {
            node = idx & 1 == 0 ? _hashPair(node, _zeros(l)) : _hashPair(filledSubtrees[l], node);
            idx >>= 1;
        }
    }

    /// @dev The root of an empty subtree of height l: zeros(0) = 0 and zeros(l) =
    /// Poseidon(zeros(l - 1), zeros(l - 1)), so zeros(DEPTH) is EMPTY_ROOT.
    function _zeros(uint32 l) internal pure returns (bytes32) {
        if (l == 0) return bytes32(0);
        if (l == 1) return 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864;
        if (l == 2) return 0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1;
        if (l == 3) return 0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238;
        if (l == 4) return 0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a;
        if (l == 5) return 0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55;
        if (l == 6) return 0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78;
        if (l == 7) return 0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d;
        if (l == 8) return 0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61;
        if (l == 9) return 0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747;
        if (l == 10) return 0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2;
        if (l == 11) return 0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636;
        if (l == 12) return 0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a;
        if (l == 13) return 0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0;
        if (l == 14) return 0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c;
        if (l == 15) return 0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92;
        if (l == 16) return 0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323;
        if (l == 17) return 0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992;
        if (l == 18) return 0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f;
        if (l == 19) return 0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca;
        return EMPTY_ROOT;
    }
}
