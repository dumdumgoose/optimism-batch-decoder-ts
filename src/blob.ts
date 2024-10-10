import { createHash } from "crypto";
import {
  Blob as CBlob,
  Bytes48,
  blobToKzgCommitment,
  verifyBlobKzgProof,
} from "c-kzg";

const BlobSize = 4096 * 32;
const MaxBlobDataSize = (4 * 31 + 3) * 1024 - 4;
const EncodingVersion = 0;
const VersionOffset = 1;
const Rounds = 1024;

function hexStringToUint8Array(hexString: string): Uint8Array {
  hexString = hexString.replace(/^0x/, "").replace(/\s/g, "");

  if (hexString.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }

  const arrayBuffer = new Uint8Array(hexString.length / 2);

  for (let i = 0; i < hexString.length; i += 2) {
    const byteValue = parseInt(hexString.substring(i, i + 2), 16);
    if (isNaN(byteValue)) {
      throw new Error("Invalid hex string");
    }
    arrayBuffer[i / 2] = byteValue;
  }

  return arrayBuffer;
}

export class Blob {
  private data: Uint8Array;

  constructor(hex: string) {
    this.data = hexStringToUint8Array(hex);
  }

  toString(): string {
    return Buffer.from(this.data).toString("hex");
  }

  terminalString(): string {
    return `${Buffer.from(this.data.slice(0, 3)).toString(
      "hex"
    )}..${Buffer.from(this.data.slice(BlobSize - 3)).toString("hex")}`;
  }

  async computeKZGCommitment(): Promise<Bytes48> {
    return blobToKzgCommitment(this.data as CBlob);
  }

  static kzgToVersionedHash(commitment: Bytes48): string {
    const hasher = createHash("sha256");
    hasher.update(commitment);
    return hasher.digest("hex");
  }

  static verifyBlobProof(
    blob: Blob,
    commitment: Bytes48,
    proof: Bytes48
  ): boolean {
    return verifyBlobKzgProof(blob.data as CBlob, commitment, proof);
  }

  fromData(data: Uint8Array): void {
    if (data.length > MaxBlobDataSize) {
      throw new Error(`Input too large: len=${data.length}`);
    }
    this.clear();

    let readOffset = 0;
    const read1 = (): number => {
      if (readOffset >= data.length) {
        return 0;
      }
      return data[readOffset++];
    };

    let writeOffset = 0;
    const buf31 = new Uint8Array(31);
    const zero31 = new Uint8Array(31);

    const read31 = (): void => {
      if (readOffset >= data.length) {
        buf31.set(zero31);
        return;
      }
      const n = Math.min(31, data.length - readOffset);
      buf31.set(data.slice(readOffset, readOffset + n));
      readOffset += n;
    };

    const write1 = (v: number): void => {
      if (writeOffset % 32 !== 0) {
        throw new Error(`Invalid byte write offset: ${writeOffset}`);
      }
      if (v & 0b1100_0000) {
        throw new Error(`Invalid 6 bit value: 0b${v.toString(2)}`);
      }
      this.data[writeOffset++] = v;
    };

    const write31 = (): void => {
      if (writeOffset % 32 !== 1) {
        throw new Error(`Invalid bytes31 write offset: ${writeOffset}`);
      }
      this.data.set(buf31, writeOffset);
      writeOffset += 31;
    };

    for (let round = 0; round < Rounds && readOffset < data.length; round++) {
      if (round === 0) {
        buf31[0] = EncodingVersion;
        const ilen = data.length;
        buf31[1] = (ilen >> 16) & 0xff;
        buf31[2] = (ilen >> 8) & 0xff;
        buf31[3] = ilen & 0xff;
        read31();
      } else {
        read31();
      }

      const x = read1();
      write1(x & 0b0011_1111);
      write31();

      read31();
      const y = read1();
      write1((y & 0b0000_1111) | ((x & 0b1100_0000) >> 2));
      write31();

      read31();
      const z = read1();
      write1(z & 0b0011_1111);
      write31();

      read31();
      write1(((z & 0b1100_0000) >> 2) | ((y & 0b1111_0000) >> 4));
      write31();
    }

    if (readOffset < data.length) {
      throw new Error(
        `Expected to fit data but failed, read offset: ${readOffset}, data length: ${data.length}`
      );
    }
  }

  toData(): Uint8Array {
    if (this.data[VersionOffset] !== EncodingVersion) {
      throw new Error(
        `Invalid encoding version, expected: ${EncodingVersion}, got: ${this.data[VersionOffset]}`
      );
    }

    const outputLen = (this.data[2] << 16) | (this.data[3] << 8) | this.data[4];
    if (outputLen > MaxBlobDataSize) {
      throw new Error(`Invalid length for blob: ${outputLen}`);
    }

    const output = new Uint8Array(MaxBlobDataSize);
    output.set(this.data.slice(5, 32), 0);

    let opos = 28;
    let ipos = 32;

    const encodedByte = new Uint8Array(4);
    encodedByte[0] = this.data[0];

    for (let i = 1; i < 4; i++) {
      [encodedByte[i], opos, ipos] = this.decodeFieldElement(
        opos,
        ipos,
        output
      );
    }
    opos = this.reassembleBytes(opos, encodedByte, output);

    for (let i = 1; i < Rounds && opos < outputLen; i++) {
      for (let j = 0; j < 4; j++) {
        [encodedByte[j], opos, ipos] = this.decodeFieldElement(
          opos,
          ipos,
          output
        );
      }
      opos = this.reassembleBytes(opos, encodedByte, output);
    }

    for (let i = outputLen; i < MaxBlobDataSize; i++) {
      if (output[i] !== 0) {
        throw new Error(`Extraneous data in output at position ${i}`);
      }
    }
    for (; ipos < BlobSize; ipos++) {
      if (this.data[ipos] !== 0) {
        throw new Error(`Extraneous data in blob at position ${ipos}`);
      }
    }

    return output.slice(0, outputLen);
  }

  private decodeFieldElement(
    opos: number,
    ipos: number,
    output: Uint8Array
  ): [number, number, number] {
    if (ipos + 32 > BlobSize) {
      throw new Error(`Invalid input position during decoding: ipos=${ipos}`);
    }
    const byteValue = this.data[ipos];
    if (byteValue & 0b1100_0000) {
      throw new Error(`Invalid field element: ${byteValue}`);
    }
    output.set(this.data.slice(ipos + 1, ipos + 32), opos);
    return [byteValue, opos + 32, ipos + 32];
  }

  private reassembleBytes(
    opos: number,
    encodedByte: Uint8Array,
    output: Uint8Array
  ): number {
    opos--;
    const x =
      (encodedByte[0] & 0b0011_1111) | ((encodedByte[1] & 0b0011_0000) << 2);
    const y =
      (encodedByte[1] & 0b0000_1111) | ((encodedByte[3] & 0b0000_1111) << 4);
    const z =
      (encodedByte[2] & 0b0011_1111) | ((encodedByte[3] & 0b0011_0000) << 2);

    output[opos - 32] = z;
    output[opos - 64] = y;
    output[opos - 96] = x;

    return opos;
  }

  clear(): void {
    this.data.fill(0);
  }
}
