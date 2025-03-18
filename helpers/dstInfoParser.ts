import { PUBLIC_KEY_LENGTH } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { DST_PROGRAM_ID } from "@thevault/dst";

export const dstInfoParser = {
  programID: DST_PROGRAM_ID,
  name: "DSTInfo",
  parse: (data: Uint8Array) => {
    const view = new DataView(data.buffer);
    const viewOffset = data.byteOffset;
    let offset: number = 8;
    const tokenMint = new PublicKey(
      data.slice(offset, (offset += PUBLIC_KEY_LENGTH))
    );
    const operator = new PublicKey(
      data.slice(offset, (offset += PUBLIC_KEY_LENGTH))
    );
    const partner = new PublicKey(
      data.slice(offset, (offset += PUBLIC_KEY_LENGTH))
    );
    const vsolReserves = new PublicKey(
      data.slice(offset, (offset += PUBLIC_KEY_LENGTH))
    );
    const lifetimeOperatorFees = view.getBigUint64(viewOffset + offset, true);
    offset += 8;
    const unclaimedOperatorFees = view.getBigUint64(viewOffset + offset, true);
    offset += 8;
    const lifetimePartnerFees = view.getBigUint64(viewOffset + offset, true);
    offset += 8;
    const unclaimedPartnerFees = view.getBigUint64(viewOffset + offset, true);
    offset += 8;
    const bump = view.getUint8(viewOffset + offset);
    offset += 1;
    const baseFee = view.getUint8(viewOffset + offset);
    offset += 1;
    const operatorFee = view.getUint16(viewOffset + offset);
    offset += 2;
    const pendingOperator = new PublicKey(
      data.slice(offset, (offset += PUBLIC_KEY_LENGTH))
    );
    return {
      tokenMint,
      operator,
      partner,
      vsolReserves,
      lifetimeOperatorFees,
      unclaimedOperatorFees,
      lifetimePartnerFees,
      unclaimedPartnerFees,
      bump,
      baseFee,
      operatorFee,
      pendingOperator,
    };
  },
};
