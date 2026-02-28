import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    SafeMath,
    StoredU256,
    StoredAddress,
} from '@btc-vision/btc-runtime/runtime';

// ── Order states ──────────────────────────────────────────────────────────────
const STATE_CREATED:   u64 = 1;
const STATE_ACCEPTED:  u64 = 2;
const STATE_FUNDED:    u64 = 3;
const STATE_COMPLETED: u64 = 4;
const STATE_CANCELLED: u64 = 5;
const STATE_DISPUTED:  u64 = 6;

// ── Pointer helpers ───────────────────────────────────────────────────────────
// StoredU256(pointer: u16, subPointer: Uint8Array)
// StoredAddress(pointer: u16)  — no subPointer!
//
// For StoredU256 we use a fixed pointer per field type,
// and encode orderId into the 32-byte subPointer.
//
// For StoredAddress we encode both the field and orderId into pointer:
//   seller pointer = 100 + orderId (base 100)
//   buyer  pointer = 200 + orderId (base 200)
// This supports up to 65335 orders per address field.

function subPtr(orderId: u64): Uint8Array {
    const buf = new Uint8Array(32);
    buf[24] = u8((orderId >> 56) & 0xff);
    buf[25] = u8((orderId >> 48) & 0xff);
    buf[26] = u8((orderId >> 40) & 0xff);
    buf[27] = u8((orderId >> 32) & 0xff);
    buf[28] = u8((orderId >> 24) & 0xff);
    buf[29] = u8((orderId >> 16) & 0xff);
    buf[30] = u8((orderId >> 8)  & 0xff);
    buf[31] = u8( orderId        & 0xff);
    return buf;
}

// Pointer bases for StoredU256 fields (each gets a unique u16 base)
const PTR_ORDER_COUNT: u16 = 1;
const PTR_PRICE:       u16 = 10;
const PTR_LOCKED:      u16 = 11;
const PTR_STATE:       u16 = 12;
const PTR_DEADLINE:    u16 = 13;
const PTR_ACCEPTED_AT: u16 = 14;

// Pointer bases for StoredAddress (orderId encoded in pointer directly)
const PTR_SELLER_BASE: u16 = 100;  // seller of order N = 100 + N
const PTR_BUYER_BASE:  u16 = 10000; // buyer  of order N = 10000 + N

@final
export class EscrowMarketplace extends OP_NET {

    private readonly _orderCount: StoredU256;

    public constructor() {
        super();
        this._orderCount = new StoredU256(PTR_ORDER_COUNT, new Uint8Array(32));
    }

    public override onDeployment(_calldata: Calldata): void {
        this._orderCount.value = u256.Zero;
    }

    public override onUpdate(_calldata: Calldata): void {
        super.onUpdate(_calldata);
    }

    // ── createOrder(price: u256, deadlineBlocks: u64) → orderId: u64 ─────────
    @method(
        { name: 'price',          type: ABIDataTypes.UINT256 },
        { name: 'deadlineBlocks', type: ABIDataTypes.UINT64  },
    )
    @returns({ name: 'orderId', type: ABIDataTypes.UINT64 })
    public createOrder(calldata: Calldata): BytesWriter {
        const price:          u256 = calldata.readU256();
        const deadlineBlocks: u64  = calldata.readU64();

        assert(price > u256.Zero,   'Price must be > 0');
        assert(deadlineBlocks >= 6, 'Deadline must be >= 6 blocks');

        const orderId: u64 = SafeMath.add64(this._orderCount.value.toU64(), 1);
        this._orderCount.value = u256.fromU64(orderId);

        const ptr = subPtr(orderId);

        // seller
        new StoredAddress(u16(PTR_SELLER_BASE + orderId)).value = Blockchain.tx.sender;

        // price, locked, state, deadline, acceptedAt
        new StoredU256(PTR_PRICE,       ptr).value = price;
        new StoredU256(PTR_LOCKED,      ptr).value = u256.Zero;
        new StoredU256(PTR_STATE,       ptr).value = u256.fromU64(STATE_CREATED);
        new StoredU256(PTR_DEADLINE,    ptr).value = u256.fromU64(
            SafeMath.add64(Blockchain.block.number, deadlineBlocks)
        );
        new StoredU256(PTR_ACCEPTED_AT, ptr).value = u256.Zero;

        const writer = new BytesWriter(8);
        writer.writeU64(orderId);
        return writer;
    }

    // ── acceptOrder(orderId: u64) → ok: bool ─────────────────────────────────
    @method({ name: 'orderId', type: ABIDataTypes.UINT64 })
    @returns({ name: 'ok', type: ABIDataTypes.BOOL })
    public acceptOrder(calldata: Calldata): BytesWriter {
        const orderId: u64 = calldata.readU64();
        const ptr = subPtr(orderId);

        const stateStore = new StoredU256(PTR_STATE, ptr);
        assert(stateStore.value.toU64() == STATE_CREATED, 'Order not in Created state');
        assert(
            Blockchain.block.number <= new StoredU256(PTR_DEADLINE, ptr).value.toU64(),
            'Order deadline passed'
        );

        new StoredAddress(u16(PTR_BUYER_BASE + orderId)).value = Blockchain.tx.sender;
        stateStore.value = u256.fromU64(STATE_ACCEPTED);
        new StoredU256(PTR_ACCEPTED_AT, ptr).value = u256.fromU64(Blockchain.block.number);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── fundOrder(orderId: u64) → ok: bool ───────────────────────────────────
    @method({ name: 'orderId', type: ABIDataTypes.UINT64 })
    @returns({ name: 'ok', type: ABIDataTypes.BOOL })
    public fundOrder(calldata: Calldata): BytesWriter {
        const orderId: u64 = calldata.readU64();
        const ptr = subPtr(orderId);

        const stateStore = new StoredU256(PTR_STATE, ptr);
        assert(stateStore.value.toU64() == STATE_ACCEPTED, 'Order not in Accepted state');
        assert(
            new StoredAddress(u16(PTR_BUYER_BASE + orderId)).value.equals(Blockchain.tx.sender),
            'Only buyer can fund'
        );

        new StoredU256(PTR_LOCKED, ptr).value = new StoredU256(PTR_PRICE, ptr).value;
        stateStore.value = u256.fromU64(STATE_FUNDED);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── confirmCompletion(orderId: u64) → ok: bool ───────────────────────────
    @method({ name: 'orderId', type: ABIDataTypes.UINT64 })
    @returns({ name: 'ok', type: ABIDataTypes.BOOL })
    public confirmCompletion(calldata: Calldata): BytesWriter {
        const orderId: u64 = calldata.readU64();
        const ptr = subPtr(orderId);

        const stateStore = new StoredU256(PTR_STATE, ptr);
        assert(stateStore.value.toU64() == STATE_FUNDED, 'Order not in Funded state');
        assert(
            new StoredAddress(u16(PTR_BUYER_BASE + orderId)).value.equals(Blockchain.tx.sender),
            'Only buyer can confirm'
        );

        new StoredU256(PTR_LOCKED, ptr).value = u256.Zero;
        stateStore.value = u256.fromU64(STATE_COMPLETED);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── cancelOrder(orderId: u64) → ok: bool ─────────────────────────────────
    @method({ name: 'orderId', type: ABIDataTypes.UINT64 })
    @returns({ name: 'ok', type: ABIDataTypes.BOOL })
    public cancelOrder(calldata: Calldata): BytesWriter {
        const orderId: u64 = calldata.readU64();
        const ptr = subPtr(orderId);

        const stateStore = new StoredU256(PTR_STATE, ptr);
        const state: u64  = stateStore.value.toU64();
        assert(
            state == STATE_CREATED  ||
            state == STATE_ACCEPTED ||
            state == STATE_FUNDED   ||
            state == STATE_DISPUTED,
            'Cannot cancel in current state'
        );
        assert(
            new StoredAddress(u16(PTR_SELLER_BASE + orderId)).value.equals(Blockchain.tx.sender) ||
            new StoredAddress(u16(PTR_BUYER_BASE  + orderId)).value.equals(Blockchain.tx.sender),
            'Only seller or buyer can cancel'
        );

        new StoredU256(PTR_LOCKED, ptr).value = u256.Zero;
        stateStore.value = u256.fromU64(STATE_CANCELLED);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── openDispute(orderId: u64) → ok: bool ─────────────────────────────────
    @method({ name: 'orderId', type: ABIDataTypes.UINT64 })
    @returns({ name: 'ok', type: ABIDataTypes.BOOL })
    public openDispute(calldata: Calldata): BytesWriter {
        const orderId: u64 = calldata.readU64();
        const ptr = subPtr(orderId);

        const stateStore = new StoredU256(PTR_STATE, ptr);
        assert(stateStore.value.toU64() == STATE_FUNDED, 'Can only dispute Funded orders');
        assert(
            new StoredAddress(u16(PTR_SELLER_BASE + orderId)).value.equals(Blockchain.tx.sender) ||
            new StoredAddress(u16(PTR_BUYER_BASE  + orderId)).value.equals(Blockchain.tx.sender),
            'Only seller or buyer can open dispute'
        );

        stateStore.value = u256.fromU64(STATE_DISPUTED);

        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ── getOrder(orderId: u64) ────────────────────────────────────────────────
    @method({ name: 'orderId', type: ABIDataTypes.UINT64 })
    @returns(
        { name: 'orderId',    type: ABIDataTypes.UINT64  },
        { name: 'seller',     type: ABIDataTypes.ADDRESS },
        { name: 'buyer',      type: ABIDataTypes.ADDRESS },
        { name: 'price',      type: ABIDataTypes.UINT256 },
        { name: 'locked',     type: ABIDataTypes.UINT256 },
        { name: 'state',      type: ABIDataTypes.UINT8   },
        { name: 'deadline',   type: ABIDataTypes.UINT64  },
        { name: 'acceptedAt', type: ABIDataTypes.UINT64  },
    )
    public getOrder(calldata: Calldata): BytesWriter {
        const orderId: u64 = calldata.readU64();
        const ptr = subPtr(orderId);

        const seller     = new StoredAddress(u16(PTR_SELLER_BASE + orderId)).value;
        const buyer      = new StoredAddress(u16(PTR_BUYER_BASE  + orderId)).value;
        const price      = new StoredU256(PTR_PRICE,       ptr).value;
        const locked     = new StoredU256(PTR_LOCKED,      ptr).value;
        const state      = u8(new StoredU256(PTR_STATE,    ptr).value.toU64());
        const deadline   = new StoredU256(PTR_DEADLINE,    ptr).value.toU64();
        const acceptedAt = new StoredU256(PTR_ACCEPTED_AT, ptr).value.toU64();

        const writer = new BytesWriter(8 + 32 + 32 + 32 + 32 + 1 + 8 + 8);
        writer.writeU64(orderId);
        writer.writeAddress(seller);
        writer.writeAddress(buyer);
        writer.writeU256(price);
        writer.writeU256(locked);
        writer.writeU8(state);
        writer.writeU64(deadline);
        writer.writeU64(acceptedAt);
        return writer;
    }

    // ── getEscrowStats() ──────────────────────────────────────────────────────
    @returns(
        { name: 'contractBalance', type: ABIDataTypes.UINT256 },
        { name: 'totalLocked',     type: ABIDataTypes.UINT256 },
        { name: 'orderCount',      type: ABIDataTypes.UINT64  },
    )
    public getEscrowStats(calldata: Calldata): BytesWriter {
        const count: u64 = this._orderCount.value.toU64();
        let totalLocked  = u256.Zero;

        for (let i: u64 = 1; i <= count; i++) {
            const state = new StoredU256(PTR_STATE, subPtr(i)).value.toU64();
            if (state == STATE_FUNDED || state == STATE_DISPUTED) {
                totalLocked = SafeMath.add(totalLocked, new StoredU256(PTR_LOCKED, subPtr(i)).value);
            }
        }

        const writer = new BytesWriter(32 + 32 + 8);
        writer.writeU256(totalLocked);
        writer.writeU256(totalLocked);
        writer.writeU64(count);
        return writer;
    }
}
