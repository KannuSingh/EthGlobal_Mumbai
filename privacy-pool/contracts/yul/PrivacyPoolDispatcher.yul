/// @title PrivacyPoolDispatcher (Nainokot privacy pool, ERC-8421 alt mempool experiment, chain 1337)
/// @notice A separate shielded pool whose notes pay the gas of a transaction the user's own
/// account sends. In the sponsored shapes the pool is the payer only: it approves payment
/// (scope 1), never execution, so the user's account stays the sender and its calls run as
/// itself. (Withdrawals and private transfers use msp's pool-as-sender shape, below.) Its proof check, root
/// binding, statement checks and field-element checks are msp d0b2131's envelope-root
/// dispatcher (devnet/altmempool/ShieldedPoolDispatcher.yul) unchanged. What differs is who
/// signs (the proof's authorizer is tx.sender, whose own signature the protocol checks in
/// frame 0) and where nullifiers live (in this pool's storage, not EIP-8250 nonce keys, since the
/// pool is not the sender).
///
/// Three transaction shapes. msp's own pool-as-sender spend ([VERIFY pool, scope 3]
/// [SENDER pool: settle] [DEFAULT tail]?, nullifiers as EIP-8250 nonce keys) works as in msp, so
/// msp's and Jalebi's clients can use this pool; see poolSenderVerify. The two sponsored shapes
/// both end with this pool's settleSponsored frame, which carries the statement (the same
/// 388-byte Spend as msp's settle, then the notes):
///
///   last frame: [VERIFY sender, scope 2] [VERIFY pool, scope 1: pay, data = proof (288 bytes)]
///               [SENDER calls ...] [DEFAULT pool: settleSponsored]
///     The pay frame checks the proof and that both nullifiers are unspent (a read of this
///     pool's storage); the last frame marks them. It is pinned like msp's settle frame, so it
///     cannot fail once payment is approved.
///
///   pre_verify: [VERIFY sender, scope 2] [DEFAULT pool: preVerify, data = selector || proof]
///               [VERIFY pool, scope 1: payPreVerified] [SENDER calls ...]
///               [DEFAULT pool: settleSponsored]
///     ERC-8421's pre_verify frame (PREFIX-010 to 120): it checks the proof and marks both
///     nullifiers spent before payment is approved; the pay frame only checks that it succeeded
///     (PREFIX-120). The writes stand only if the transaction is valid.
///
/// A settle frame with one more word (the refund note's inner) gets the fee's unused part back as
/// a note: see PrivacyPoolLogic._refundNote and gasMeter() below.
///
/// Either way a note can pay for one transaction only, and the mempool rule that keeps a
/// shared pool from being throttled is: at most one pending transaction per (pool, nullifier).
/// @dev Runtime layout as msp's: this code, then the PrivacyPoolLogic address and the Groth16
/// verifier address as two 32-byte words. Every call that is not one of the four entries below
/// is delegated to PrivacyPoolLogic.
object "PrivacyPoolDispatcher" {
    code {
        // PrivacyPoolLogic.currentRoot (storage slot 22) starts as EMPTY_ROOT.
        sstore(22, 0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e)
        let rsize := datasize("runtime")
        codecopy(rsize, sub(codesize(), 64), 64)
        datacopy(0, dataoffset("runtime"), rsize)
        return(0, add(rsize, 64))
    }

    object "runtime" {
        code {
            function txParam(param) -> value { value := verbatim_1i_1o(hex"B0", param) }
            function frameParam(frameIndex, param) -> value {
                value := verbatim_2i_1o(hex"B3", frameIndex, param)
            }
            function frameDataLoad(frameIndex, offset) -> value {
                value := verbatim_2i_1o(hex"B1", offset, frameIndex)
            }
            function sigParam(signatureIndex, param) -> value {
                value := verbatim_2i_1o(hex"B4", signatureIndex, param)
            }
            // RECENTROOTREFLOAD(index, field): field 0 source_id, 1 slot, 2 root of the
            // envelope's recent-root reference `index`. verbatim puts field on top, as the
            // fork pops it first.
            function recentRootRef(index, field) -> value {
                value := verbatim_2i_1o(hex"B6", field, index)
            }
            // APPROVE with an empty return region and scope 1, APPROVE_PAYMENT: the pool pays,
            // it never acts as the sender.
            function approvePayment() { verbatim_3i_0o(hex"AA", 0, 0, 1) }
            // APPROVE with scope 3, execution and payment: the pool-as-sender shape.
            function approveExecutionAndPayment() { verbatim_3i_0o(hex"AA", 0, 0, 3) }

            // Refusals revert with a 4-byte error selector. errCanonical, errValue, errDomain
            // and errNullifier are ShieldedPoolLogic's NotCanonical(), ValueTooLarge(),
            // InvalidDomain() and ZeroNullifier().
            function fail(sel) {
                mstore(0, shl(224, sel))
                revert(0, 4)
            }
            function errShape() -> s { s := 0xe6d22e28 }
            function errRoot() -> s { s := 0xaf501e1c }
            function errProof() -> s { s := 0x7fcdd1f4 }
            function errKeys() -> s { s := 0x586e51ed }
            function errCanonical() -> s { s := 0xd7c7beeb }
            function errValue() -> s { s := 0x2ad907fb }
            function errFee() -> s { s := 0x315cb54e }
            function errDomain() -> s { s := 0xeb127982 }
            function errNullifier() -> s { s := 0xcbbbbfe1 }
            function errAuthorizer() -> s { s := 0xb4683784 }
            // PrivacyPool-only refusals: SponsorShape(), NullifierSpent(), SettleOutOfPlace(),
            // DuplicateNullifier(), PreVerifyMissing().
            function errSponsorShape() -> s { s := 0x260f9145 }
            function errSpent() -> s { s := 0x63734faa }
            function errSettlePlace() -> s { s := 0x11f83ac1 }
            function errDuplicate() -> s { s := 0xe1200f1d }
            function errPreVerify() -> s { s := 0x766d28bb }

            // BN254's scalar field order p, the circuit's field.
            function scalarField() -> v {
                v := 21888242871839275222246405745257275088548364400416034343698204186575808495617
            }
            // BN254's base field order q, the field of the proof's point coordinates.
            function baseField() -> v {
                v := 21888242871839275222246405745257275088696311157297823662689037894645226208583
            }
            // Amounts are below 2^128, the circuit's range check.
            function maxValue() -> v { v := 0x100000000000000000000000000000000 }
            // ShieldedPoolLogic.DOMAIN_TAG.
            function domainTag() -> v {
                v := 0xa9d03fa1cd97bcf3294dc8e3bb024f555393c98967b356967fa502abab366ed3
            }

            // The EIP-8272 source_id that publishEpochRoot(epoch) writes under:
            // keccak256(address20(pool) || bytes32(epoch)).
            function sourceId(epoch) -> id {
                mstore(0, shl(96, address()))
                mstore(0x14, epoch)
                id := keccak256(0, 0x34)
            }

            // The nullifier domain, as ShieldedPoolLogic.domainFor computes it. It takes the
            // epoch whose source_id the recent-root frame names, so a spender cannot choose
            // another epoch's domain and give one note a second nullifier.
            function domainVal(epoch) -> d {
                mstore(0, domainTag())
                mstore(0x20, chainid())
                mstore(0x40, address())
                mstore(0x60, epoch)
                d := mod(keccak256(0, 0x80), scalarField())
            }

            function impl() -> a {
                codecopy(0, sub(codesize(), 64), 32)
                a := and(mload(0), 0xffffffffffffffffffffffffffffffffffffffff)
            }
            function verifierAddr() -> a {
                codecopy(0, sub(codesize(), 32), 32)
                a := and(mload(0), 0xffffffffffffffffffffffffffffffffffffffff)
            }

            // Checks the statement in frame settleIndex's settleSponsored(Spend) call and the
            // proof in this frame's calldata at offset base (0 in pay, 4 in pre_verify).
            function verifyProof(settleIndex, base) {
                // settle((root,rootSlot,epoch,domain,nf1,nf2,out1,out2,
                //         publicAmount,fee,recipient,authorizer)), one word each after the
                // 4-byte selector.
                let root := frameDataLoad(settleIndex, 4)
                let rootSlot := frameDataLoad(settleIndex, 36)
                let epoch := frameDataLoad(settleIndex, 68)
                let dom := frameDataLoad(settleIndex, 100)
                let nf1 := frameDataLoad(settleIndex, 132)
                let nf2 := frameDataLoad(settleIndex, 164)
                let out1 := frameDataLoad(settleIndex, 196)
                let out2 := frameDataLoad(settleIndex, 228)
                let pub := frameDataLoad(settleIndex, 260)
                let fee := frameDataLoad(settleIndex, 292)
                let recipient := frameDataLoad(settleIndex, 324)
                let authorizer := frameDataLoad(settleIndex, 356)

                // A settlement that fails after approval burns the notes, so every value
                // settlement refuses or cannot decode is refused before approval. EIP-8250
                // also asks applications that derive nonce keys to refuse a key of zero.
                if iszero(nf1) { fail(errNullifier()) }
                if iszero(nf2) { fail(errNullifier()) }
                if or(shr(64, rootSlot), shr(64, epoch)) { fail(errCanonical()) }
                if or(iszero(authorizer), shr(160, authorizer)) { fail(errAuthorizer()) }
                if shr(160, recipient) { fail(errCanonical()) }
                if iszero(eq(iszero(pub), iszero(recipient))) { fail(errShape()) }
                if iszero(eq(dom, domainVal(epoch))) { fail(errDomain()) }

                // The verifier sees only (beta, gamma, alpha), and gamma reduces each word
                // mod p, so a word must be the canonical encoding of the circuit's field
                // element. Otherwise a note owner could re-prove a spend with a value plus
                // p: the proof would verify, the pool would approve and pay the gas, and
                // settlement would revert. An aliased nullifier is a fresh nonce key, so
                // the pool would pay again on every alias.
                let p := scalarField()
                if iszero(lt(root, p)) { fail(errCanonical()) }
                if iszero(lt(dom, p)) { fail(errCanonical()) }
                if iszero(lt(nf1, p)) { fail(errCanonical()) }
                if iszero(lt(nf2, p)) { fail(errCanonical()) }
                if iszero(lt(out1, p)) { fail(errCanonical()) }
                if iszero(lt(out2, p)) { fail(errCanonical()) }
                if iszero(lt(pub, maxValue())) { fail(errValue()) }
                if iszero(lt(fee, maxValue())) { fail(errValue()) }

                // Calldata from base is the 256-byte proof (A, then B, then C), then beta, which must
                // be a field element; the verifier also checks it.
                let beta := calldataload(add(base, 256))
                if iszero(lt(beta, p)) { fail(errProof()) }

                // Refuse non-canonical coordinates (q or more) and points at infinity before
                // calling the verifier. The patched verifier refuses them too
                // (VerifierCanonical.t.sol), so this is defense in depth.
                let q := baseField()
                for { let o := 0 } lt(o, 256) { o := add(o, 32) } {
                    if iszero(lt(calldataload(add(base, o)), q)) { fail(errProof()) }
                }
                if iszero(or(calldataload(base), calldataload(add(base, 32)))) { fail(errProof()) }
                if iszero(or(or(calldataload(add(base, 64)), calldataload(add(base, 96))), or(calldataload(add(base, 128)), calldataload(add(base, 160))))) {
                    fail(errProof())
                }
                if iszero(or(calldataload(add(base, 192)), calldataload(add(base, 224)))) { fail(errProof()) }

                // Hybrid compression (eprint 2025/1500): alpha = keccak256(statement) mod p,
                // and gamma is the statement evaluated as a polynomial at alpha + beta,
                // highest term first. The statement is written at 0x200, past the verifier
                // call built at 0x80 below, which ends at 0x1e4.
                let st := 0x200
                mstore(st, nf1)
                mstore(add(st, 0x20), nf2)
                mstore(add(st, 0x40), out1)
                mstore(add(st, 0x60), out2)
                mstore(add(st, 0x80), root)
                mstore(add(st, 0xa0), dom)
                mstore(add(st, 0xc0), pub)
                mstore(add(st, 0xe0), fee)
                mstore(add(st, 0x100), recipient)
                mstore(add(st, 0x120), authorizer)
                let alpha := mod(keccak256(st, 0x140), p)
                let sigma := addmod(alpha, beta, p)
                let gamma := 0
                for { let o := 0x140 } o { o := sub(o, 0x20) } {
                    gamma := addmod(mulmod(gamma, sigma, p), mload(add(st, sub(o, 0x20))), p)
                }

                // verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[3]) with the
                // public signals in circom's order, [beta, gamma, alpha].
                let m := 0x80
                mstore(m, shl(224, 0x11479fea))
                calldatacopy(add(m, 4), base, 256)
                mstore(add(m, 0x104), beta)
                mstore(add(m, 0x124), gamma)
                mstore(add(m, 0x144), alpha)

                let ok := staticcall(500000, verifierAddr(), m, 0x164, 0, 32)
                if iszero(ok) { fail(errProof()) }
                if iszero(eq(returndatasize(), 32)) { fail(errProof()) }
                if iszero(eq(mload(0), 1)) { fail(errProof()) }
            }


            // settleSponsored((bytes32,uint64,uint64,bytes32,bytes32,bytes32,bytes32,bytes32,
            // uint256,uint256,address,address)), preVerify() and payPreVerified().
            function settleSelector() -> s { s := 0xf25d18a7 }
            function preVerifySelector() -> s { s := 0xdce1336f }
            function paySelector() -> s { s := 0x484f83b5 }

            // PrivacyPoolLogic.nullifierSpent is the mapping at slot 26.
            function nullifierSlot(nf) -> slot {
                mstore(0, nf)
                mstore(0x20, 26)
                slot := keccak256(0, 0x40)
            }

            // An optional first frame: EIP-8141's expiry verifier (VERIFY on 0x8141, no approval,
            // no batch, an 8-byte deadline). The protocol runs it and drops the transaction after
            // the deadline. When it is there, every sponsored frame below sits one place later.
            function lead() -> x {
                if iszero(eq(frameParam(0, 0x00), 0x8141)) { leave }
                if iszero(eq(frameParam(0, 0x02), 1)) { fail(errSponsorShape()) }
                if frameParam(0, 0x03) { fail(errSponsorShape()) }
                if frameParam(0, 0x07) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(0, 0x04), 8)) { fail(errSponsorShape()) }
                x := 1
            }

            // The parts both shapes share. proofFrame is the frame that carries the proof (1),
            // firstCall the first of the user's SENDER frames (2, or 3 after pre_verify).
            function checkSponsored(proofFrame, firstCall, base) {
                let frames := txParam(0x09)
                let last := sub(frames, 1)
                if lt(frames, add(firstCall, 2)) { fail(errSponsorShape()) }
                if iszero(eq(txParam(0x0A), proofFrame)) { fail(errSponsorShape()) }

                // Frame 0 (1 after an expiry frame): the sender's own VERIFY frame, approving
                // execution only. Its default code (or its own code) checks the sender's
                // signature over the whole transaction, which covers every frame below.
                let sender := txParam(0x02)
                let x := sub(proofFrame, 1)
                if iszero(eq(frameParam(x, 0x02), 1)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(x, 0x00), sender)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(x, 0x03), 2)) { fail(errSponsorShape()) }
                if frameParam(x, 0x08) { fail(errSponsorShape()) }

                // The user's calls: SENDER frames, so they run as the sender and can never act as
                // the pool. Any target, value from the sender's own balance. The one before the
                // last frame must not open an atomic batch, or a failing call could take
                // settlement down with it.
                for { let i := firstCall } lt(i, last) { i := add(i, 1) } {
                    if iszero(eq(frameParam(i, 0x02), 2)) { fail(errSponsorShape()) }
                }
                if frameParam(sub(last, 1), 0x07) { fail(errSponsorShape()) }

                // The last frame: settleSponsored on this pool, a DEFAULT frame outside any batch,
                // with msp's pinned settlement limits (2,000,000 execution, 550,000 state), so it
                // cannot run out of gas after payment.
                if iszero(eq(frameParam(last, 0x00), address())) { fail(errSponsorShape()) }
                if frameParam(last, 0x02) { fail(errSponsorShape()) }
                if frameParam(last, 0x03) { fail(errSponsorShape()) }
                if frameParam(last, 0x08) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(last, 0x01), 2000000)) { fail(errSponsorShape()) }
                let settleLength := frameParam(last, 0x04)
                switch or(eq(settleLength, 484), eq(settleLength, 1572))
                case 1 {
                    if iszero(eq(frameParam(last, 0x09), 550000)) { fail(errSponsorShape()) }
                }
                default {
                    // Refund mode: one more word, the refund note's inner, and room for its leaf's
                    // state (650,000).
                    if iszero(or(eq(settleLength, 516), eq(settleLength, 1604))) { fail(errSponsorShape()) }
                    if iszero(eq(frameParam(last, 0x09), 650000)) { fail(errSponsorShape()) }
                    if iszero(lt(frameDataLoad(last, sub(settleLength, 32)), scalarField())) { fail(errCanonical()) }
                    // The refund prices the transaction from intrinsic gas plus the frames' use,
                    // which is what it is charged only while the calldata floor does not bind
                    // max_gas. That holds when the frames' execution limits cover the floor's
                    // upper bound; settlement's 2,000,000 alone covers about 30 KB of data.
                    let execLimits := 0
                    for { let i := 0 } lt(i, frames) { i := add(i, 1) } {
                        execLimits := add(execLimits, frameParam(i, 0x01))
                    }
                    if lt(execLimits, floorBound()) { fail(errSponsorShape()) }
                }
                if iszero(eq(shr(224, frameDataLoad(last, 0)), settleSelector())) { fail(errSponsorShape()) }

                // The proof's authorizer is the sender, so a watcher cannot lift the proof into a
                // transaction of their own: only the sender's signature passes frame 0.
                let authorizer := frameDataLoad(last, 356)
                if iszero(eq(authorizer, sender)) { fail(errAuthorizer()) }

                // Two distinct nullifiers: marking one twice would spend one note as two inputs.
                let nf1 := frameDataLoad(last, 132)
                let nf2 := frameDataLoad(last, 164)
                if eq(nf1, nf2) { fail(errDuplicate()) }

                // One EIP-8272 reference in the envelope, naming a root this pool published, as
                // in msp's envelope dispatcher.
                if iszero(eq(txParam(0x11), 1)) { fail(errRoot()) }
                let rootSlot := frameDataLoad(last, 36)
                let epoch := frameDataLoad(last, 68)
                if or(shr(64, rootSlot), shr(64, epoch)) { fail(errCanonical()) }
                if iszero(eq(recentRootRef(0, 0), sourceId(epoch))) { fail(errRoot()) }
                if iszero(eq(recentRootRef(0, 1), rootSlot)) { fail(errRoot()) }
                if iszero(eq(recentRootRef(0, 2), frameDataLoad(last, 4))) { fail(errRoot()) }

                verifyProof(last, base)

                // The pool pays, so the proof's fee must cover the transaction's maximum cost.
                if lt(frameDataLoad(last, 292), txParam(0x06)) { fail(errFee()) }
            }

            // An upper bound of the EIP-7623 calldata floor: 16 gas per token, 4 tokens per byte of
            // frame data and of each signature (signer 20, msg at most 32, signature), plus 600 bytes
            // for the nonce fields and 128 per recent-root reference.
            function floorBound() -> g {
                let bytes := add(600, mul(128, txParam(0x11)))
                let frames := txParam(0x09)
                for { let i := 0 } lt(i, frames) { i := add(i, 1) } {
                    bytes := add(bytes, frameParam(i, 0x04))
                }
                let sigs := txParam(0x0B)
                for { let i := 0 } lt(i, sigs) { i := add(i, 1) } {
                    bytes := add(bytes, add(52, sigParam(i, 0x03)))
                }
                g := mul(64, bytes)
            }

            // gasMeter(): what the current frame's refund is priced from, six words. execBefore is
            // the intrinsic gas (max_gas less every frame's two limits, exact while the calldata
            // floor does not bind max_gas, which checkSponsored ensures in refund mode) plus every
            // finished frame's execution use; stateBefore their state use; floorTotal the intrinsic
            // gas plus floorBound(), the least the execution side may be charged; then this frame's
            // execution and state limits and its state gas left. Read-only; outside a frame
            // transaction the first TXPARAM halts.
            function gasMeter() {
                let cur := txParam(0x0A)
                let frames := txParam(0x09)
                let declared := 0
                for { let i := 0 } lt(i, frames) { i := add(i, 1) } {
                    declared := add(declared, add(frameParam(i, 0x01), frameParam(i, 0x09)))
                }
                let intrinsic := sub(div(txParam(0x06), txParam(0x04)), declared)
                let execBefore := intrinsic
                let stateBefore := 0
                for { let i := 0 } lt(i, cur) { i := add(i, 1) } {
                    execBefore := add(execBefore, frameParam(i, 0x0A))
                    stateBefore := add(stateBefore, frameParam(i, 0x0B))
                }
                mstore(0, execBefore)
                mstore(0x20, stateBefore)
                mstore(0x40, add(intrinsic, floorBound()))
                mstore(0x60, frameParam(cur, 0x01))
                mstore(0x80, frameParam(cur, 0x09))
                mstore(0xa0, txParam(0x0C))
                return(0, 0xc0)
            }

            // Last-frame shape, frame 1: VERIFY(pool), scope 1, 288 bytes of proof.
            function payWithProof() {
                let x := lead()
                if iszero(eq(frameParam(add(x, 1), 0x00), address())) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 1), 0x02), 1)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 1), 0x03), 1)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 1), 0x04), 288)) { fail(errSponsorShape()) }
                if frameParam(add(x, 1), 0x08) { fail(errSponsorShape()) }
                checkSponsored(add(x, 1), add(x, 2), 0)
                // Both nullifiers unspent: the only storage this frame reads, all of it this
                // pool's own, at slots keyed by the nullifier.
                let last := sub(txParam(0x09), 1)
                if sload(nullifierSlot(frameDataLoad(last, 132))) { fail(errSpent()) }
                if sload(nullifierSlot(frameDataLoad(last, 164))) { fail(errSpent()) }
                approvePayment()
            }

            // pre_verify shape, frame 1: DEFAULT(pool), preVerify() then the proof. It checks
            // everything the pay frame of the other shape checks, then marks both nullifiers.
            function preVerify() {
                let x := lead()
                if iszero(eq(frameParam(add(x, 1), 0x00), address())) { fail(errSponsorShape()) }
                if frameParam(add(x, 1), 0x02) { fail(errSponsorShape()) }
                if frameParam(add(x, 1), 0x03) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 1), 0x04), 292)) { fail(errSponsorShape()) }
                if frameParam(add(x, 1), 0x08) { fail(errSponsorShape()) }
                // Frame 2 is this pool's pay frame, which approves only after this one succeeded.
                if iszero(eq(frameParam(add(x, 2), 0x00), address())) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 2), 0x02), 1)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 2), 0x03), 1)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 2), 0x04), 4)) { fail(errSponsorShape()) }
                if frameParam(add(x, 2), 0x08) { fail(errSponsorShape()) }
                if iszero(eq(shr(224, frameDataLoad(add(x, 2), 0)), paySelector())) { fail(errSponsorShape()) }
                checkSponsored(add(x, 1), add(x, 3), 4)
                let last := sub(txParam(0x09), 1)
                let s1 := nullifierSlot(frameDataLoad(last, 132))
                let s2 := nullifierSlot(frameDataLoad(last, 164))
                if sload(s1) { fail(errSpent()) }
                if sload(s2) { fail(errSpent()) }
                sstore(s1, 1)
                sstore(s2, 1)
            }

            // pre_verify shape, frame 2: VERIFY(pool), scope 1. It approves payment only if frame 1
            // was this pool's preVerify and succeeded (PREFIX-120).
            function payPreVerified() {
                let x := lead()
                if iszero(eq(txParam(0x0A), add(x, 2))) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 2), 0x00), address())) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 2), 0x03), 1)) { fail(errSponsorShape()) }
                if iszero(eq(frameParam(add(x, 1), 0x00), address())) { fail(errPreVerify()) }
                if frameParam(add(x, 1), 0x02) { fail(errPreVerify()) }
                if iszero(eq(frameParam(add(x, 1), 0x04), 292)) { fail(errPreVerify()) }
                if iszero(eq(shr(224, frameDataLoad(add(x, 1), 0)), preVerifySelector())) { fail(errPreVerify()) }
                if iszero(eq(frameParam(add(x, 1), 0x05), 1)) { fail(errPreVerify()) }
                approvePayment()
            }

            // msp's settle(Spend), the pool-as-sender settlement.
            function poolSettleSelector() -> s { s := 0x921fcac7 }

            // Pool-as-sender shape (msp d0b2131's envelope-root dispatcher, unchanged but for the
            // nullifierSpent reads and the settle frame's state limit):
            //   [VERIFY pool, scope 3: proof] [SENDER pool: settle(Spend) + notes] [DEFAULT tail]?
            // The nullifiers are this transaction's two EIP-8250 nonce keys at sequence 0, and,
            // as in the sponsored shapes, must be unspent in nullifierSpent, which settle marks:
            // so a note spent in either shape can never be spent in the other.
            function poolSenderVerify() {
                if iszero(eq(txParam(0x02), address())) { fail(errShape()) }
                let frames := txParam(0x09)
                if iszero(or(eq(frames, 2), eq(frames, 3))) { fail(errShape()) }
                if iszero(eq(txParam(0x0A), 0)) { fail(errShape()) }
                if iszero(eq(txParam(0x0B), 1)) { fail(errShape()) }
                if txParam(0x07) { fail(errShape()) }
                if iszero(eq(txParam(0x0E), 2)) { fail(errKeys()) }
                if txParam(0x01) { fail(errKeys()) }
                if iszero(eq(txParam(0x11), 1)) { fail(errRoot()) }

                // One secp256k1 signature from the proof's authorizer over the whole transaction.
                let authorizer := frameDataLoad(1, 356)
                if or(iszero(authorizer), shr(160, authorizer)) { fail(errAuthorizer()) }
                if iszero(eq(sigParam(0, 0), authorizer)) { fail(errAuthorizer()) }
                if iszero(eq(sigParam(0, 1), 1)) { fail(errAuthorizer()) }
                if sigParam(0, 2) { fail(errAuthorizer()) }

                // Frame 0: this VERIFY frame on the pool, flags 3, the 288-byte proof, no value.
                if iszero(eq(frameParam(0, 0x00), address())) { fail(errShape()) }
                if iszero(eq(frameParam(0, 0x02), 1)) { fail(errShape()) }
                if iszero(eq(frameParam(0, 0x03), 3)) { fail(errShape()) }
                if iszero(eq(frameParam(0, 0x04), 288)) { fail(errShape()) }
                if frameParam(0, 0x08) { fail(errShape()) }

                // Frame 1: settle(Spend) as the pool, pinned at 2,000,000 execution and 750,000
                // state (msp's 550,000 plus the two nullifierSpent slots), outside any batch.
                if iszero(eq(frameParam(1, 0x00), address())) { fail(errShape()) }
                if iszero(eq(frameParam(1, 0x01), 2000000)) { fail(errShape()) }
                if iszero(eq(frameParam(1, 0x09), 750000)) { fail(errShape()) }
                if iszero(eq(frameParam(1, 0x02), 2)) { fail(errShape()) }
                if frameParam(1, 0x03) { fail(errShape()) }
                let settleLength := frameParam(1, 0x04)
                if iszero(or(eq(settleLength, 484), eq(settleLength, 1572))) { fail(errShape()) }
                if frameParam(1, 0x08) { fail(errShape()) }
                if iszero(eq(shr(224, frameDataLoad(1, 0)), poolSettleSelector())) { fail(errShape()) }

                // Frame 2, if present: a DEFAULT call with zero value and flags, never SENDER.
                if eq(frames, 3) {
                    if iszero(frameParam(2, 0x00)) { fail(errShape()) }
                    if frameParam(2, 0x02) { fail(errShape()) }
                    if frameParam(2, 0x03) { fail(errShape()) }
                    if frameParam(2, 0x08) { fail(errShape()) }
                }

                // The nonce keys are exactly the two nullifiers (keccak256(count || keys), sorted).
                let nf1 := frameDataLoad(1, 132)
                let nf2 := frameDataLoad(1, 164)
                let lo := nf1
                let hi := nf2
                if gt(lo, hi) { lo := nf2 hi := nf1 }
                mstore(0, 2)
                mstore(0x20, lo)
                mstore(0x40, hi)
                if iszero(eq(txParam(0x0F), keccak256(0, 0x60))) { fail(errKeys()) }
                if sload(nullifierSlot(nf1)) { fail(errSpent()) }
                if sload(nullifierSlot(nf2)) { fail(errSpent()) }

                // The exact EIP-8272 reference the protocol checked.
                let rootSlot := frameDataLoad(1, 36)
                let epoch := frameDataLoad(1, 68)
                if or(shr(64, rootSlot), shr(64, epoch)) { fail(errCanonical()) }
                if iszero(eq(recentRootRef(0, 0), sourceId(epoch))) { fail(errRoot()) }
                if iszero(eq(recentRootRef(0, 1), rootSlot)) { fail(errRoot()) }
                if iszero(eq(recentRootRef(0, 2), frameDataLoad(1, 4))) { fail(errRoot()) }

                verifyProof(1, 0)
                if lt(frameDataLoad(1, 292), txParam(0x06)) { fail(errFee()) }
                approveExecutionAndPayment()
            }

            // The last frame of either shape. It delegates to PrivacyPoolLogic.settleSponsored only
            // as this transaction's last frame, after the pool's own validation frames for this
            // statement succeeded: the pay frame (last-frame shape) or pre_verify and pay.
            function checkSettlePlace() {
                let x := lead()
                let cur := txParam(0x0A)
                if iszero(eq(cur, sub(txParam(0x09), 1))) { fail(errSettlePlace()) }
                if iszero(eq(frameParam(cur, 0x00), address())) { fail(errSettlePlace()) }
                if frameParam(cur, 0x02) { fail(errSettlePlace()) }
                if iszero(eq(frameParam(add(x, 1), 0x00), address())) { fail(errSettlePlace()) }
                if iszero(eq(frameParam(add(x, 1), 0x05), 1)) { fail(errSettlePlace()) }
                switch frameParam(add(x, 1), 0x02)
                case 1 {
                    if iszero(eq(frameParam(add(x, 1), 0x04), 288)) { fail(errSettlePlace()) }
                }
                case 0 {
                    if iszero(eq(frameParam(add(x, 1), 0x04), 292)) { fail(errSettlePlace()) }
                    if iszero(eq(frameParam(add(x, 2), 0x00), address())) { fail(errSettlePlace()) }
                    if iszero(eq(frameParam(add(x, 2), 0x02), 1)) { fail(errSettlePlace()) }
                    if iszero(eq(frameParam(add(x, 2), 0x05), 1)) { fail(errSettlePlace()) }
                }
                default { fail(errSettlePlace()) }
            }

            // Entries. Outside a frame transaction the first TXPARAM halts, so none of them can
            // be called directly.
            if eq(calldatasize(), 288) {
                switch eq(txParam(0x02), address())
                case 1 { poolSenderVerify() }
                default { payWithProof() }
                stop()
            }
            let sel := shr(224, calldataload(0))
            if and(eq(calldatasize(), 292), eq(sel, preVerifySelector())) {
                preVerify()
                stop()
            }
            if and(eq(calldatasize(), 4), eq(sel, paySelector())) {
                payPreVerified()
                stop()
            }
            if and(eq(calldatasize(), 4), eq(sel, 0x43f97ae5)) {
                gasMeter()
            }
            if and(gt(calldatasize(), 3), eq(sel, settleSelector())) {
                checkSettlePlace()
            }

            // Delegate to the logic (settleSponsored too, once checked above).
            let target := impl()
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(0x1c9c380, target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
