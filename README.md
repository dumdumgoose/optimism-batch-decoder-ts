## Optimism Batch Decoder in Typescript

An experimental optimism batch decoder cli tool in typescript for testing. DO NOT use this in production.

## Run

```
pnpm install

pnpm run fetch -- --l1 {L1_RPC} --l1-beacon {L1_BEACON_CHAIN_RPC} --sender 0x6887246668a3b87F54DeB3b94Ba47a6f63F32985 --out ./raw --inbox 0xFF00000000000000000000000000000000000010 --start 20917985 --end 20918229

pnpm run reassemble -- --in ./main --out ./result
```