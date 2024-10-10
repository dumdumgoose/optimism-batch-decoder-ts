import { Readable, PassThrough } from "stream";
import * as zlib from "zlib";
import { Frame } from "./frame";
import * as RLP from "rlp";
import { ethers } from "ethers";

// Constants and Enums
const ZlibCM8 = 8;
const ZlibCM15 = 15;
const ChannelVersionBrotli = 1;
const MaxSpanBatchElementCount = 10_000_000;
const DuplicateErr = new Error("duplicate frame");

export const SingularBatchType = 0;
export const SpanBatchType = 1;

// Transaction Types
const LegacyTxType = 0x0;
const AccessListTxType = 0x1;
const DynamicFeeTxType = 0x2;

type ChannelID = string;

export enum CompressionAlgo {
  Zlib = "Zlib",
  Brotli = "Brotli",
}

export interface Batch {
  batchType: number;
  timestamp: number;
}

export interface InnerBatchData {
  batchType: number;
  decode(r: Buffer | Uint8Array | RLP.NestedUint8Array): Promise<void>;
}

function processRLPData(data: Uint8Array | RLP.NestedUint8Array): any {
  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  } else if (Array.isArray(data)) {
    return data.map(processRLPData);
  } else {
    throw new Error("Unexpected RLP data type");
  }
}

export class BatchData {
  inner?: InnerBatchData;
  comprAlgo?: CompressionAlgo;

  get batchType(): number {
    if (!this.inner) {
      throw new Error("inner data not set");
    }
    return this.inner.batchType;
  }

  async fromDecodedData(
    decodedData: Uint8Array | RLP.NestedUint8Array
  ): Promise<void> {
    await this.decodeTyped(decodedData);
  }

  async unmarshalBinary(data: Buffer): Promise<void> {
    const decodedData = RLP.decode(data);
    await this.decodeTyped(decodedData);
  }

  private async decodeTyped(
    decodedData: Uint8Array | RLP.NestedUint8Array
  ): Promise<void> {
    if (!decodedData || !(typeof decodedData === "object")) {
      throw new Error("invalid decoded data");
    }

    let batchType: number;
    let innerData: Uint8Array | RLP.NestedUint8Array;

    if (Array.isArray(decodedData)) {
      if (decodedData.length === 0) {
        throw new Error("batch too short");
      }
      batchType = Number(Buffer.from(decodedData[0] as Uint8Array)[0]);
      innerData = decodedData.slice(1);
    } else if (decodedData instanceof Uint8Array) {
      if (decodedData.length === 0) {
        throw new Error("batch too short");
      }
      batchType = decodedData[0];
      innerData = decodedData.subarray(1);
    } else {
      throw new Error("unexpected decoded data type");
    }

    let inner: InnerBatchData;
    switch (batchType) {
      case SingularBatchType:
        inner = new SingularBatch();
        break;
      case SpanBatchType:
        inner = new RawSpanBatch();
        break;
      default:
        throw new Error(`unrecognized batch type: ${batchType}`);
    }
    await inner.decode(innerData);
    this.inner = inner;
  }
}

// SingularBatch Implementation
export class SingularBatch implements InnerBatchData, Batch {
  parentHash: string; // Hex string
  epochNum: bigint;
  epochHash: string; // Hex string
  timestamp: number;
  transactions: string[]; // Array of transaction data

  constructor() {
    this.parentHash = "";
    this.epochNum = 0n;
    this.epochHash = "";
    this.timestamp = 0;
    this.transactions = [];
  }

  get batchType(): number {
    return SingularBatchType;
  }

  get timestampValue(): number {
    return this.timestamp;
  }

  async decode(decodedData: Uint8Array | RLP.NestedUint8Array): Promise<void> {
    if (!Array.isArray(decodedData) || decodedData.length < 5) {
      throw new Error("invalid RLP data for SingularBatch");
    }
    this.parentHash = Buffer.from(decodedData[0] as Uint8Array).toString("hex");
    this.epochNum = BigInt(
      "0x" + Buffer.from(decodedData[1] as Uint8Array).toString("hex")
    );
    this.epochHash = Buffer.from(decodedData[2] as Uint8Array).toString("hex");
    this.timestamp = Number(
      BigInt("0x" + Buffer.from(decodedData[3] as Uint8Array).toString("hex"))
    );
    const transactionsData = decodedData[4];
    this.transactions = processRLPData(transactionsData);
  }
}

// SpanBatchElement class
export class SpanBatchElement {
  epochNum: bigint;
  timestamp: number;
  transactions: Buffer[];

  constructor() {
    this.epochNum = 0n;
    this.timestamp = 0;
    this.transactions = [];
  }
}

// SpanBatch class implementation
export class SpanBatch implements InnerBatchData, Batch {
  parentCheck: Buffer;
  l1OriginCheck: Buffer;
  genesisTimestamp: number;
  chainId: bigint;
  batches: SpanBatchElement[];

  // Caching fields
  originBits: bigint;
  blockTxCounts: number[];
  sbtxs: SpanBatchTxs;

  constructor() {
    this.parentCheck = Buffer.alloc(20);
    this.l1OriginCheck = Buffer.alloc(20);
    this.genesisTimestamp = 0;
    this.chainId = 0n;
    this.batches = [];
    this.originBits = 0n;
    this.blockTxCounts = [];
    this.sbtxs = new SpanBatchTxs();
  }

  get batchType(): number {
    return SpanBatchType;
  }

  get timestamp(): number {
    if (this.batches.length === 0) {
      throw new Error("No batches available");
    }
    return this.batches[0].timestamp;
  }

  async decode(r: Buffer | Uint8Array | RLP.NestedUint8Array): Promise<void> {
    throw new Error("SpanBatch decode not implemented");
  }
}

// BufferReader utility class
class BufferReader {
  buffer: Buffer;
  offset: number;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readUvarint(): number {
    let x = 0;
    let s = 0;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.buffer.length) {
        throw new Error("buffer underflow");
      }
      const b = this.buffer[this.offset++];
      if (b < 0x80) {
        if (i === 9 && b > 1) {
          throw new Error("uvarint overflows a 64-bit integer");
        }
        return x | (b << s);
      }
      x |= (b & 0x7f) << s;
      s += 7;
    }
    throw new Error("uvarint overflows a 64-bit integer");
  }

  readBytes(length: number): Buffer {
    if (this.offset + length > this.buffer.length) {
      throw new Error("buffer underflow");
    }
    const bytes = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  decodeSpanBatchBits(count: number): bigint {
    const byteLength = Math.ceil(count / 8);
    const bitsBuffer = this.readBytes(byteLength);
    let bits = 0n;
    for (let i = 0; i < bitsBuffer.length; i++) {
      bits = (bits << 8n) | BigInt(bitsBuffer[i]);
    }
    return bits;
  }
}

// SpanBatchSignature interface
interface SpanBatchSignature {
  v: bigint;
  r: bigint;
  s: bigint;
}

// SpanBatchTxData interface
interface SpanBatchTxData {
  txType(): number;
  fromRLPArray(data: any[]): void;
  value: bigint;
  gasPrice?: bigint;
  gasTipCap?: bigint;
  gasFeeCap?: bigint;
  data: Buffer;
  accessList?: any[];
}

// SpanBatchLegacyTxData class
class SpanBatchLegacyTxData implements SpanBatchTxData {
  value: bigint;
  gasPrice: bigint;
  data: Buffer;

  constructor(
    value: bigint = 0n,
    gasPrice: bigint = 0n,
    data: Buffer = Buffer.alloc(0)
  ) {
    this.value = value;
    this.gasPrice = gasPrice;
    this.data = data;
  }

  txType(): number {
    return LegacyTxType;
  }

  fromRLPArray(data: any[]): void {
    this.value = ethers.toBigInt(data[0]);
    this.gasPrice = ethers.toBigInt(data[1]);
    this.data = Buffer.from(data[2]);
  }

  toString(): string {
    return `LegacyTxData{value: ${this.value}, gasPrice: ${this.gasPrice}, data: ${this.data.toString(
      "hex"
    )}}`;
  }
}

// SpanBatchAccessListTxData class
class SpanBatchAccessListTxData implements SpanBatchTxData {
  value: bigint;
  gasPrice: bigint;
  data: Buffer;
  accessList: any[];

  constructor(
    value: bigint = 0n,
    gasPrice: bigint = 0n,
    data: Buffer = Buffer.alloc(0),
    accessList: any[] = []
  ) {
    this.value = value;
    this.gasPrice = gasPrice;
    this.data = data;
    this.accessList = accessList;
  }

  txType(): number {
    return AccessListTxType;
  }

  fromRLPArray(data: any[]): void {
    this.value = ethers.toBigInt(data[0]);
    this.gasPrice = ethers.toBigInt(data[1]);
    this.data = Buffer.from(data[2]);
    this.accessList = data[3];
  }

  toString(): string {
    return `AccessListTxData{value: ${this.value}, gasPrice: ${this.gasPrice}, data: ${this.data.toString(
      "hex"
    )}, accessList: ${this.accessList}}`;
  }
}

// SpanBatchDynamicFeeTxData class
class SpanBatchDynamicFeeTxData implements SpanBatchTxData {
  value: bigint;
  gasTipCap: bigint;
  gasFeeCap: bigint;
  data: Buffer;
  accessList: any[];

  constructor(
    value: bigint = 0n,
    gasTipCap: bigint = 0n,
    gasFeeCap: bigint = 0n,
    data: Buffer = Buffer.alloc(0),
    accessList: any[] = []
  ) {
    this.value = value;
    this.gasTipCap = gasTipCap;
    this.gasFeeCap = gasFeeCap;
    this.data = data;
    this.accessList = accessList;
  }

  txType(): number {
    return DynamicFeeTxType;
  }

  fromRLPArray(data: any[]): void {
    this.value = ethers.toBigInt(data[0]);
    this.gasTipCap = ethers.toBigInt(data[1]);
    this.gasFeeCap = ethers.toBigInt(data[2]);
    this.data = Buffer.from(data[3]);
    this.accessList = data[4];
  }

  toString(): string {
    return `DynamicFeeTxData{value: ${this.value}, gasTipCap: ${this.gasTipCap}, gasFeeCap: ${this.gasFeeCap}, data: ${this.data.toString(
      "hex"
    )}, accessList: ${this.accessList}}`;
  }
}

// SpanBatchTx class
class SpanBatchTx {
  inner: SpanBatchTxData;

  constructor(inner?: SpanBatchTxData) {
    if (!inner) {
      throw new Error("inner data not set");
    }

    this.inner = inner;
  }

  get txType(): number {
    return this.inner.txType();
  }

  // UnmarshalBinary decodes the canonical encoding of transactions
  static unmarshalBinary(data: Buffer): SpanBatchTx {
    if (data.length === 0) {
      throw new Error("Transaction data is empty");
    }

    const firstByte = data[0];

    if (firstByte > 0x7f) {
      // Legacy transaction (RLP list)
      const decoded = RLP.decode(data) as any[];
      const txData = new SpanBatchLegacyTxData();
      txData.fromRLPArray(decoded);
      return new SpanBatchTx(txData);
    } else {
      // EIP2718 typed transaction
      const txType = data[0];
      const payload = data.subarray(1);
      const decoded = RLP.decode(payload) as any[];
      let txData: SpanBatchTxData;
      if (txType === AccessListTxType) {
        txData = new SpanBatchAccessListTxData();
      } else if (txType === DynamicFeeTxType) {
        txData = new SpanBatchDynamicFeeTxData();
      } else {
        throw new Error(`Unsupported transaction type: ${txType}`);
      }
      txData.fromRLPArray(decoded);
      return new SpanBatchTx(txData);
    }
  }

  // convertToFullTx converts SpanBatchTx to ethers.Transaction
  async convertToFullTx(
    nonce: number,
    gasLimit: number,
    to: string | null,
    chainID: bigint,
    v: bigint,
    r: bigint,
    s: bigint
  ): Promise<ethers.Transaction> {
    const tx = ethers.Transaction.from({
      type: this.txType,
      nonce,
      gasLimit,
      gasPrice: this.inner.gasPrice,
      maxFeePerGas: this.inner.gasFeeCap,
      maxPriorityFeePerGas: this.inner.gasTipCap,
      accessList: this.inner.accessList,
      to: to ? to : undefined,
      value: this.inner.value,
      data: ethers.hexlify(this.inner.data),
      chainId: Number(chainID),
      signature: {
        v: ethers.toBigInt(v),
        r: ethers.toBeHex(ethers.toBeHex(r), 32),
        s: ethers.toBeHex(ethers.toBeHex(s), 32),
      },
    });

    return tx;
  }
}

// SpanBatchTxs class
class SpanBatchTxs {
  totalBlockTxCount: number;
  contractCreationBits: bigint;
  yParityBits: bigint;
  txSigs: SpanBatchSignature[];
  txNonces: number[];
  txGases: number[];
  txTos: Buffer[];
  txDatas: Buffer[];
  protectedBits: bigint;

  // Intermediate variables
  txTypes: number[];
  totalLegacyTxCount: number;

  constructor() {
    this.totalBlockTxCount = 0;
    this.contractCreationBits = 0n;
    this.yParityBits = 0n;
    this.txSigs = [];
    this.txNonces = [];
    this.txGases = [];
    this.txTos = [];
    this.txDatas = [];
    this.protectedBits = 0n;
    this.txTypes = [];
    this.totalLegacyTxCount = 0;
  }

  async decode(reader: BufferReader, blockTxCounts: number[]): Promise<void> {
    this.totalBlockTxCount = blockTxCounts.reduce((a, b) => a + b, 0);

    // Decode contractCreationBits
    this.contractCreationBits = reader.decodeSpanBatchBits(
      this.totalBlockTxCount
    );

    // Decode yParityBits
    this.yParityBits = reader.decodeSpanBatchBits(this.totalBlockTxCount);

    // Decode txSigs
    this.txSigs = [];
    for (let i = 0; i < this.totalBlockTxCount; i++) {
      const r = reader.readBytes(32);
      const s = reader.readBytes(32);

      this.txSigs.push({
        v: 0n, // Will be recovered later
        r: BigInt("0x" + r.toString("hex")),
        s: BigInt("0x" + s.toString("hex")),
      });
    }

    // Decode txTos
    const contractCreationCount = this.countBits(
      this.contractCreationBits,
      this.totalBlockTxCount
    );
    const txToCount = this.totalBlockTxCount - contractCreationCount;

    this.txTos = [];
    for (let i = 0; i < txToCount; i++) {
      this.txTos.push(reader.readBytes(20));
    }

    // Decode txDatas
    this.txDatas = [];
    this.txTypes = [];
    for (let i = 0; i < this.totalBlockTxCount; i++) {
      const [txData, txType] = this.readTxData(reader);
      this.txDatas.push(txData);
      this.txTypes.push(txType);
      if (txType === LegacyTxType) {
        this.totalLegacyTxCount++;
      }
    }

    // Decode txNonces
    this.txNonces = [];
    for (let i = 0; i < this.totalBlockTxCount; i++) {
      this.txNonces.push(reader.readUvarint());
    }

    // Decode txGases
    this.txGases = [];
    for (let i = 0; i < this.totalBlockTxCount; i++) {
      this.txGases.push(reader.readUvarint());
    }

    // Decode protectedBits
    this.protectedBits = reader.decodeSpanBatchBits(this.totalLegacyTxCount);
  }

  private readTxData(reader: BufferReader): [Buffer, number] {
    const offset = reader.offset;
    const firstByte = reader.buffer[offset];
    let txType = 0;
    let txData: Buffer;

    if (firstByte <= 0x7f) {
      // Non-legacy transaction (EIP-2718)
      txType = firstByte;
      reader.offset++; // Consume the txType byte
      const txPayload = this.readRLPListData(reader);
      txData = Buffer.concat([Buffer.from([txType]), txPayload]);
    } else {
      // Legacy transaction
      txData = Buffer.from(this.readRLPListData(reader));
    }

    return [txData, txType];
  }

  private readRLPListData(reader: BufferReader): Uint8Array {
    const bufToRead = reader.buffer.subarray(reader.offset);
    const decoded = RLP.decode(bufToRead, true);
    if (decoded.data instanceof Uint8Array) {
      throw new Error("Expected RLP list for transaction data");
    }

    const consumed = bufToRead.length - decoded.remainder.length;
    reader.offset += consumed;

    return RLP.encode(decoded.data);
  }

  async recoverV(chainID: bigint): Promise<void> {
    let protectedBitsIdx = 0;
    for (let idx = 0; idx < this.txTypes.length; idx++) {
      const txType = this.txTypes[idx];
      const yParityBit = this.getBit(this.yParityBits, idx);
      let v: bigint;

      if (txType === LegacyTxType) {
        // Legacy transaction
        const protectedBit = this.getBit(this.protectedBits, protectedBitsIdx);
        protectedBitsIdx++;
        if (protectedBit === 0) {
          // Unprotected
          v = BigInt(27 + yParityBit);
        } else {
          // EIP-155
          v = chainID * 2n + 35n + BigInt(yParityBit);
        }
      } else {
        // EIP-2718 transactions
        v = BigInt(yParityBit);
      }
      this.txSigs[idx].v = v;
    }
  }

  getBit(bits: bigint, position: number): number {
    return ethers.toNumber((bits >> ethers.toBigInt(position)) & 1n);
  }

  countBits(bits: bigint, totalBits: number): number {
    let count = 0;
    for (let i = 0; i < totalBits; i++) {
      if (this.getBit(bits, i) === 1) {
        count++;
      }
    }
    return count;
  }

  async fullTxs(chainID: bigint): Promise<Buffer[]> {
    const txs: Buffer[] = [];
    let toIdx = 0;
    for (let idx = 0; idx < this.totalBlockTxCount; idx++) {
      const stx = SpanBatchTx.unmarshalBinary(this.txDatas[idx]);
      const nonce = this.txNonces[idx];
      const gas = this.txGases[idx];
      let to: string | null = null;
      const bit = this.getBit(this.contractCreationBits, idx);
      if (bit === 0) {
        if (this.txTos.length <= toIdx) {
          throw new Error("Insufficient 'to' addresses");
        }
        to = "0x" + this.txTos[toIdx].toString("hex");
        toIdx++;
      }
      const v = this.txSigs[idx].v;
      const r = this.txSigs[idx].r;
      const s = this.txSigs[idx].s;
      const tx = await stx.convertToFullTx(nonce, gas, to, chainID, v, r, s);
      const serializedTx = tx.serialized;
      txs.push(Buffer.from(serializedTx.substring(2), "hex"));
    }
    return txs;
  }
}

// RawSpanBatch Implementation
export class RawSpanBatch implements InnerBatchData, Batch {
  relTimestamp: number;
  l1OriginNum: number;
  parentCheck: Buffer;
  l1OriginCheck: Buffer;

  blockCount: number;
  originBits: bigint;
  blockTxCounts: number[];
  txs: SpanBatchTxs;

  constructor() {
    this.relTimestamp = 0;
    this.l1OriginNum = 0;
    this.parentCheck = Buffer.alloc(20);
    this.l1OriginCheck = Buffer.alloc(20);
    this.blockCount = 0;
    this.originBits = 0n;
    this.blockTxCounts = [];
    this.txs = new SpanBatchTxs();
  }

  get timestamp(): number {
    return this.relTimestamp;
  }

  get batchType(): number {
    return SpanBatchType;
  }

  async decode(r: Buffer | Uint8Array | RLP.NestedUint8Array): Promise<void> {
    let buffer: Buffer;

    if (Buffer.isBuffer(r)) {
      buffer = r;
    } else if (r instanceof Uint8Array) {
      buffer = Buffer.from(r);
    } else {
      buffer = Buffer.from(RLP.encode(r));
    }

    const reader = new BufferReader(buffer);
    // Decode relTimestamp
    this.relTimestamp = reader.readUvarint();
    // Decode l1OriginNum
    this.l1OriginNum = reader.readUvarint();
    // Decode parentCheck
    this.parentCheck = reader.readBytes(20);
    // Decode l1OriginCheck
    this.l1OriginCheck = reader.readBytes(20);
    // Decode blockCount
    this.blockCount = reader.readUvarint();
    if (this.blockCount > MaxSpanBatchElementCount) {
      throw new Error("span batch size limit reached");
    }
    if (this.blockCount === 0) {
      throw new Error("span-batch must not be empty");
    }
    // Decode originBits
    this.originBits = reader.decodeSpanBatchBits(this.blockCount);
    // Decode blockTxCounts
    this.blockTxCounts = [];
    for (let i = 0; i < this.blockCount; i++) {
      const count = reader.readUvarint();
      if (count > MaxSpanBatchElementCount) {
        throw new Error("span batch size limit reached");
      }
      this.blockTxCounts.push(count);
    }
    // Decode txs
    this.txs = new SpanBatchTxs();
    await this.txs.decode(reader, this.blockTxCounts);
  }

  private getBit(bits: bigint, position: number): number {
    return Number((bits >> BigInt(position)) & 1n);
  }

  // Implement the derive method
  async derive(
    blockTime: number,
    genesisTimestamp: number,
    chainId: bigint
  ): Promise<SpanBatch> {
    if (this.blockCount === 0) {
      throw new Error("Empty span batch");
    }

    const blockOriginNums = new Array<number>(this.blockCount);
    let l1OriginBlockNumber = this.l1OriginNum;
    for (let i = this.blockCount - 1; i >= 0; i--) {
      blockOriginNums[i] = l1OriginBlockNumber;
      if (this.getBit(this.originBits, i) === 1 && i > 0) {
        l1OriginBlockNumber--;
      }
    }

    // Recover 'v' values in signatures
    await this.txs.recoverV(chainId);

    // Reconstruct full transactions
    const fullTxs = await this.txs.fullTxs(chainId);

    // Build the SpanBatch
    const spanBatch = new SpanBatch();
    spanBatch.parentCheck = this.parentCheck;
    spanBatch.l1OriginCheck = this.l1OriginCheck;
    spanBatch.genesisTimestamp = genesisTimestamp;
    spanBatch.chainId = chainId;
    spanBatch.originBits = this.originBits;
    spanBatch.blockTxCounts = this.blockTxCounts;
    spanBatch.sbtxs = this.txs;

    let txIdx = 0;
    for (let i = 0; i < this.blockCount; i++) {
      const batch = new SpanBatchElement();
      batch.timestamp = genesisTimestamp + this.relTimestamp + blockTime * i;
      batch.epochNum = BigInt(blockOriginNums[i]);
      batch.transactions = [];
      for (let j = 0; j < this.blockTxCounts[i]; j++) {
        batch.transactions.push(fullTxs[txIdx]);
        txIdx++;
      }
      spanBatch.batches.push(batch);
    }
    return spanBatch;
  }
}

// Channel class implementation
export class Channel {
  id: ChannelID;
  openBlock: number;
  size: number;
  closed: boolean;
  highestFrameNumber: number;
  endFrameNumber: number;
  inputs: Map<number, Frame>;
  highestL1InclusionBlock: number;

  constructor(id: ChannelID, openBlock: number) {
    this.id = id;
    this.openBlock = openBlock;
    this.size = 0;
    this.closed = false;
    this.highestFrameNumber = 0;
    this.endFrameNumber = 0;
    this.inputs = new Map<number, Frame>();
    this.highestL1InclusionBlock = openBlock;
  }

  addFrame(frame: Frame): void {
    const frameId = Buffer.from(frame.id).toString("hex");
    if (frameId !== this.id) {
      throw new Error(
        `frame id does not match channel id. Expected ${this.id}, got ${frameId}`
      );
    }

    if (frame.isLast && this.closed) {
      throw new Error(
        `cannot add ending frame to a closed channel. id ${this.id}`
      );
    }

    if (this.inputs.has(frame.frameNumber)) {
      throw DuplicateErr;
    }

    if (this.closed && frame.frameNumber >= this.endFrameNumber) {
      throw new Error(
        `frame number (${frame.frameNumber}) is greater than or equal to end frame number (${this.endFrameNumber}) of a closed channel`
      );
    }

    if (frame.isLast) {
      this.endFrameNumber = frame.frameNumber;
      this.closed = true;
    }

    if (frame.isLast && this.endFrameNumber < this.highestFrameNumber) {
      for (const [id, prunedFrame] of this.inputs.entries()) {
        if (id >= this.endFrameNumber) {
          this.inputs.delete(id);
          this.size -= frameSize(prunedFrame);
        }
      }
      this.highestFrameNumber = this.endFrameNumber;
    }

    if (frame.frameNumber > this.highestFrameNumber) {
      this.highestFrameNumber = frame.frameNumber;
    }

    if (this.highestL1InclusionBlock < frame.inclusionBlock) {
      this.highestL1InclusionBlock = frame.inclusionBlock;
    }

    this.inputs.set(frame.frameNumber, frame);
    this.size += frameSize(frame);
  }

  get openBlockNumber(): number {
    return this.openBlock;
  }

  get highestBlock(): number {
    return this.highestL1InclusionBlock;
  }

  get channelSize(): number {
    return this.size;
  }

  isReady(): boolean {
    if (!this.closed) {
      return false;
    }

    if (this.inputs.size !== this.endFrameNumber + 1) {
      return false;
    }

    for (let i = 0; i <= this.endFrameNumber; i++) {
      if (!this.inputs.has(i)) {
        return false;
      }
    }
    return true;
  }

  reader(): Readable {
    const passThrough = new PassThrough();
    (async () => {
      for (let i = 0; i <= this.endFrameNumber; i++) {
        const frame = this.inputs.get(i);
        if (!frame) {
          throw new Error(
            "dev error in channel.reader. Must be called after the channel is ready."
          );
        }
        passThrough.write(frame.data);
        await new Promise((resolve) => setImmediate(resolve));
      }
      passThrough.end();
    })();
    return passThrough;
  }
}

export function batchReader(
  r: Readable
): Promise<() => Promise<BatchData | null>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    r.on("data", (chunk) => {
      chunks.push(chunk);
    });

    r.on("end", () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        return reject(new Error("empty input stream"));
      }

      let decompressedBuffer: Buffer;
      let comprAlgo: CompressionAlgo;
      const compressionType = buffer[0];
      if (
        (compressionType & 0x0f) === ZlibCM8 ||
        (compressionType & 0x0f) === ZlibCM15
      ) {
        try {
          decompressedBuffer = zlib.unzipSync(buffer);
        } catch (err) {
          return reject(err);
        }
        comprAlgo = CompressionAlgo.Zlib;
      } else if (compressionType === ChannelVersionBrotli) {
        const data = buffer.subarray(1);
        try {
          decompressedBuffer = zlib.brotliDecompressSync(data);
        } catch (err) {
          return reject(err);
        }
        comprAlgo = CompressionAlgo.Brotli;
      } else {
        return reject(
          new Error(
            `cannot distinguish the compression algo used given type byte ${compressionType}`
          )
        );
      }

      let offset = 0;

      const readBatch = async (): Promise<BatchData | null> => {
        if (offset >= decompressedBuffer.length) {
          return null;
        }
        const remainingBuffer = decompressedBuffer.subarray(offset);
        try {
          const { data: decodedData, remainder } = RLP.decode(
            remainingBuffer,
            true
          );
          const consumedLength = remainingBuffer.length - remainder.length;
          offset += consumedLength;

          const batchData = new BatchData();
          await batchData.fromDecodedData(decodedData);
          batchData.comprAlgo = comprAlgo;
          return batchData;
        } catch (err) {
          throw err;
        }
      };

      resolve(readBatch);
    });

    r.on("error", (err) => {
      reject(err);
    });
  });
}

function frameSize(frame: Frame): number {
  // Assuming an overhead of 200 bytes as per your adjustment
  return frame.data.length + 200;
}
