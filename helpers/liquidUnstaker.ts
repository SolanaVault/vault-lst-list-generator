import type { Token } from "@saberhq/token-utils";
import type { PublicKey } from "@solana/web3.js";

export type StakedToken =
  | {
      token: Token;
      source: "StakePool";
      stakePoolAddress: PublicKey;
      amount?: string;
    }
  | {
      token: Token;
      source: "Sanctum";
      stakePoolAddress: PublicKey;
      amount?: string;
    }
  | {
      token: Token;
      source: "StakeAccount";
      stakeAccount: PublicKey;
      voteAccount: PublicKey;
      amount: string;
      validator?: any;
    };

/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/liquid_unstaker.json`.
 */
export interface LiquidUnstaker {
  address: "2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo";
  metadata: {
    name: "liquidUnstaker";
    version: "0.1.0";
    spec: "0.1.0";
    description: "Created with Anchor";
  };
  instructions: [
    {
      name: "createOrUpdateTokenMetadata";
      discriminator: [203, 87, 105, 175, 156, 139, 235, 180];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "authority";
          signer: true;
        },
        {
          name: "payer";
          docs: [
            "Payer of the metadata account creation (in case not present already)"
          ];
          writable: true;
          signer: true;
        },
        {
          name: "tokenMint";
          docs: ["Token [Mint]."];
          writable: true;
        },
        {
          name: "metadataProgram";
        },
        {
          name: "metadataInfo";
          writable: true;
        },
        {
          name: "systemProgram";
        }
      ];
      args: [
        {
          name: "name";
          type: "string";
        },
        {
          name: "symbol";
          type: "string";
        },
        {
          name: "uri";
          type: "string";
        }
      ];
    },
    {
      name: "depositSol";
      discriminator: [108, 81, 78, 117, 125, 155, 56, 200];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "solVault";
          writable: true;
        },
        {
          name: "lpMint";
          writable: true;
        },
        {
          name: "user";
          writable: true;
          signer: true;
        },
        {
          name: "userLpAccount";
          writable: true;
        },
        {
          name: "systemProgram";
        },
        {
          name: "tokenProgram";
        },
        {
          name: "associatedTokenProgram";
        }
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        }
      ];
    },
    {
      name: "initializePool";
      discriminator: [95, 180, 10, 172, 84, 174, 232, 40];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "authority";
          writable: true;
          signer: true;
        },
        {
          name: "solVault";
          writable: true;
        },
        {
          name: "lpMint";
          writable: true;
        },
        {
          name: "managerFeeAccount";
        },
        {
          name: "systemProgram";
        },
        {
          name: "tokenProgram";
        },
        {
          name: "rent";
        }
      ];
      args: [
        {
          name: "feeMax";
          type: "u32";
        },
        {
          name: "feeMin";
          type: "u32";
        },
        {
          name: "minSolForMinFee";
          type: "u64";
        },
        {
          name: "managerFeePct";
          type: "u8";
        },
        {
          name: "vaultLamportsCap";
          type: "u64";
        }
      ];
    },
    {
      name: "liquidUnstakeLst";
      discriminator: [84, 174, 251, 245, 108, 64, 33, 185];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "payer";
          writable: true;
          signer: true;
        },
        {
          name: "userTransferAuthority";
          signer: true;
        },
        {
          name: "userLstAccount";
          writable: true;
        },
        {
          name: "solVault";
          writable: true;
        },
        {
          name: "userSolAccount";
          writable: true;
        },
        {
          name: "managerFeeAccount";
          writable: true;
        },
        {
          name: "stakePool";
          writable: true;
        },
        {
          name: "stakePoolValidatorList";
          writable: true;
        },
        {
          name: "stakePoolWithdrawAuthority";
        },
        {
          name: "stakePoolManagerFeeAccount";
          writable: true;
        },
        {
          name: "stakePoolMint";
          writable: true;
        },
        {
          name: "tokenProgram";
        },
        {
          name: "stakeProgram";
        },
        {
          name: "stakePoolProgram";
        },
        {
          name: "systemProgram";
        },
        {
          name: "clock";
        },
        {
          name: "stakeHistory";
        }
      ];
      args: [
        {
          name: "lstAmounts";
          type: {
            array: ["u64", 5];
          };
        },
        {
          name: "minimumLamportsOut";
          type: {
            option: "u64";
          };
        }
      ];
    },
    {
      name: "liquidUnstakeStakeAccount";
      discriminator: [6, 242, 242, 0, 61, 230, 96, 58];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "user";
          writable: true;
          signer: true;
        },
        {
          name: "stakeAccount";
          writable: true;
        },
        {
          name: "stakeAccountInfo";
          writable: true;
        },
        {
          name: "solVault";
          writable: true;
        },
        {
          name: "userSolAccount";
          writable: true;
        },
        {
          name: "managerFeeAccount";
          writable: true;
        },
        {
          name: "stakeProgram";
        },
        {
          name: "tokenProgram";
        },
        {
          name: "systemProgram";
        },
        {
          name: "clock";
        }
      ];
      args: [
        {
          name: "minimumLamportsOut";
          type: {
            option: "u64";
          };
        }
      ];
    },
    {
      name: "update";
      discriminator: [219, 200, 88, 176, 158, 63, 253, 127];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "solVault";
          writable: true;
        },
        {
          name: "stakeProgram";
        },
        {
          name: "tokenProgram";
        },
        {
          name: "clock";
        },
        {
          name: "stakeHistory";
        },
        {
          name: "systemProgram";
        }
      ];
      args: [];
    },
    {
      name: "withdrawSol";
      discriminator: [145, 131, 74, 136, 65, 137, 42, 38];
      accounts: [
        {
          name: "pool";
          writable: true;
        },
        {
          name: "solVault";
          writable: true;
        },
        {
          name: "lpMint";
          writable: true;
        },
        {
          name: "user";
          writable: true;
          signer: true;
        },
        {
          name: "userLpAccount";
          writable: true;
        },
        {
          name: "systemProgram";
        },
        {
          name: "tokenProgram";
        }
      ];
      args: [
        {
          name: "lpTokens";
          type: "u64";
        }
      ];
    }
  ];
  accounts: [
    {
      name: "pool";
      discriminator: [241, 154, 109, 4, 17, 177, 109, 188];
    },
    {
      name: "stakeAccountInfo";
      discriminator: [168, 159, 248, 231, 54, 98, 130, 203];
    }
  ];
  errors: [
    {
      code: 6000;
      name: "insufficientSolVaultBalance";
      msg: "Insufficient SOL in the vault";
    },
    {
      code: 6001;
      name: "mathOverflow";
      msg: "Math operation overflow";
    },
    {
      code: 6002;
      name: "mathUnderflow";
      msg: "Math operation underflow";
    },
    {
      code: 6003;
      name: "noFeesToClaim";
      msg: "No fees to claim.";
    },
    {
      code: 6004;
      name: "stakePoolWithdrawalFailed";
      msg: "Failed to withdraw from SPL Stake Pool";
    },
    {
      code: 6005;
      name: "setAuthorityFailed";
      msg: "Failed to set authority on stake account";
    },
    {
      code: 6006;
      name: "deactivateStakeFailed";
      msg: "Failed to deactivate stake account.";
    },
    {
      code: 6007;
      name: "invalidWithdrawAuthority";
      msg: "invalidWithdrawAuthority";
    },
    {
      code: 6008;
      name: "invalidStakeAccountOwner";
      msg: "Invalid stake account owner";
    },
    {
      code: 6009;
      name: "invalidStakeAccountState";
      msg: "Invalid stake account state";
    },
    {
      code: 6010;
      name: "unauthorizedStakeAccount";
      msg: "Unauthorized stake account";
    },
    {
      code: 6011;
      name: "stakeAccountAlreadyProcessed";
      msg: "Stake account has already been processed.";
    },
    {
      code: 6012;
      name: "stakeAccountMismatch";
      msg: "Stake accounts mismatch";
    },
    {
      code: 6013;
      name: "failedToDeserialize";
      msg: "Failed to deserialize";
    },
    {
      code: 6014;
      name: "invalidRemainingAccounts";
      msg: "Remaining accounts passed are not valid";
    },
    {
      code: 6015;
      name: "stakeAccountLockupUnableToLoadLockup";
      msg: "Unable to load the lockup information of the stake account";
    },
    {
      code: 6016;
      name: "stakeAccountLockupIsInForce";
      msg: "The lockup of the stake account is in force";
    },
    {
      code: 6017;
      name: "stakeAccountNotFullyDeactivated";
      msg: "The stake account is not yet fully deactivated";
    },
    {
      code: 6018;
      name: "invalidStakePoolProgram";
      msg: "Unsppoorted stake pool program";
    },
    {
      code: 6019;
      name: "insufficientLpTokenBalance";
      msg: "Insufficient LP tokens";
    },
    {
      code: 6020;
      name: "depositMustBeLargerThanZero";
      msg: "Must deposit more than 0 lamports";
    },
    {
      code: 6021;
      name: "invalidUserLpAccount";
      msg: "Invalid user LP account";
    },
    {
      code: 6022;
      name: "lpTokensToMintIsZero";
      msg: "Uanble to mint any LP tokens as the amount calculated is zero";
    },
    {
      code: 6023;
      name: "stakeAccountDoesNotBelongToPool";
      msg: "Stake account does not belong to pool";
    },
    {
      code: 6024;
      name: "feeMaxLessThanFeeMin";
      msg: "fee_max cannot be lower than fee_min";
    },
    {
      code: 6025;
      name: "feeMaxTooHigh";
      msg: "fee_max is set to a too high value";
    },
    {
      code: 6026;
      name: "managerFeePctTooHigh";
      msg: "manager_fee_pct is set to a too high value";
    },
    {
      code: 6027;
      name: "incorrectMetadataAccount";
      msg: "Metadata account address is incorrect";
    },
    {
      code: 6028;
      name: "solVaultLamportsCapReached";
      msg: "The cap has been reached for the pool's SOL vault";
    },
    {
      code: 6029;
      name: "slippageExceeded";
      msg: "The slippage was exceeded";
    }
  ];
  types: [
    {
      name: "pool";
      type: {
        kind: "struct";
        fields: [
          {
            name: "authority";
            docs: ["The authority managing the pool"];
            type: "pubkey";
          },
          {
            name: "solVault";
            docs: ["The vault containing the SOL managed by the pool"];
            type: "pubkey";
          },
          {
            name: "lpMint";
            docs: [
              "The LP mint of the pool, used by the liquidity provider instructions"
            ];
            type: "pubkey";
          },
          {
            name: "managerFeeAccount";
            docs: ["The manage account that will receive manager fees"];
            type: "pubkey";
          },
          {
            name: "totalLpTokens";
            docs: ["Total LP tokens minted"];
            type: "u64";
          },
          {
            name: "totalAccruedFees";
            docs: ["Total fees accrued in the pool"];
            type: "u64";
          },
          {
            name: "totalDeactivatingStake";
            docs: [
              "The total amount of stake in stake accounts marked for deactivation"
            ];
            type: "u64";
          },
          {
            name: "feeMax";
            docs: [
              "The max fee that can be charged in basis points, 100% = FEE_BPS"
            ];
            type: "u32";
          },
          {
            name: "feeMin";
            docs: [
              "The max fee that can be charged in basis points, 100% = FEE_BPS"
            ];
            type: "u32";
          },
          {
            name: "minSolForMinFee";
            docs: [
              "The minimum amount of SOL required in the pool to reach the minimum fee, in lamports"
            ];
            type: "u64";
          },
          {
            name: "managerFeePct";
            docs: [
              "The part of the fee that will go to the manager of the pool, in percentage points"
            ];
            type: "u8";
          },
          {
            name: "bump";
            docs: ["Bump seed for the pool PDA"];
            type: "u8";
          },
          {
            name: "solVaultBump";
            docs: ["Bump seed for the sol_vault PDA"];
            type: "u8";
          },
          {
            name: "solVaultLamports";
            docs: ["Accounting for the pool vault"];
            type: "u64";
          },
          {
            name: "solVaultLamportsCap";
            docs: ["Maximum amount of SOL that can be deposited in the pool"];
            type: "u64";
          },
          {
            name: "reserved";
            docs: ["Reservation for future contract changes"];
            type: {
              array: ["u8", 32];
            };
          }
        ];
      };
    },
    {
      name: "stakeAccountInfo";
      type: {
        kind: "struct";
        fields: [
          {
            name: "stakeAccount";
            type: "pubkey";
          },
          {
            name: "pool";
            type: "pubkey";
          },
          {
            name: "stakeLamports";
            type: "u64";
          }
        ];
      };
    }
  ];
}
