import { Command } from "commander";
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { parseFrames, Frame } from "./frame";
import { L1BeaconClient } from "./l1-beacon-client";
import { BatchData, Channel, RawSpanBatch, SingularBatch, SpanBatchType, batchReader } from "./channel";

const program = new Command();

interface FetchBatchesConfig {
  start: number;
  end: number;
  chainId: number;
  batchInbox: string;
  batchSenders: string[];
  outDirectory: string;
  concurrentRequests: number;
}

interface ReassembleConfig {
  batchInbox: string;
  inDirectory: string;
  outDirectory: string;
  l2ChainId: number;
  l2GenesisTime: number;
  l2BlockTime: number;
}

function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  return Buffer.from(uint8Array).toString("base64");
}

program
  .command("fetch")
  .description("Fetches batches in the specified range")
  .requiredOption(
    "--start <number>",
    "First block (inclusive) to fetch",
    parseInt
  )
  .requiredOption("--end <number>", "Last block (exclusive) to fetch", parseInt)
  .requiredOption("--inbox <string>", "Batch Inbox Address")
  .requiredOption("--sender <string>", "Batch Sender Address")
  .option(
    "--out <string>",
    "Cache directory for the found transactions",
    "/tmp/batch_decoder/transactions_cache"
  )
  .requiredOption("--l1 <string>", "L1 RPC URL")
  .option(
    "--l1-beacon <string>",
    "Address of L1 Beacon-node HTTP endpoint to use"
  )
  .option(
    "--concurrent-requests <number>",
    "Concurrency level when fetching L1",
    parseInt,
    10
  )
  .action(async (options) => {
    console.log("Starting fetch command with options:", options);

    const config: FetchBatchesConfig = {
      start: options.start,
      end: options.end,
      chainId: parseInt(options.chainId),
      batchInbox: options.inbox,
      batchSenders: [options.sender.toLowerCase()],
      outDirectory: options.out,
      concurrentRequests: options.concurrentRequests,
    };

    console.log("Fetching batches with config:", config);

    const provider = new ethers.JsonRpcProvider(options.l1);
    const beaconClient = options.l1Beacon
      ? new L1BeaconClient(options.l1Beacon)
      : undefined;
    const concurrentRequests = config.concurrentRequests;

    for (let i = config.start; i < config.end; i++) {
      console.log(`Fetching block number: ${i}`);
      try {
        const block = await provider.getBlock(i, true);
        if (!block) {
          throw new Error(`Failed to fetch block ${i}`);
        }

        let blobIndex = 0;

        for (let tx of block?.prefetchedTransactions) {
          if (
            tx.to &&
            tx.to.toLowerCase() === config.batchInbox.toLowerCase()
          ) {
            console.log(`Processing transaction: ${tx.hash}`);
            const sender = tx.from;
            if (!config.batchSenders.includes(sender.toLowerCase())) {
              console.warn(
                `Invalid sender (${sender}) for transaction: ${tx.hash}`
              );
              continue;
            }

            let datas: Uint8Array[] = [];
            if (tx.type !== 3) {
              datas.push(Buffer.from(tx.data.slice(2), "hex"));
            } else {
              if (!tx.blobVersionedHashes) {
                console.warn(
                  `Transaction ${tx.hash} is a batch but has no blob hashes`
                );
                continue;
              }
              const hashes = tx.blobVersionedHashes.map((hash, index) => ({
                index: blobIndex + index,
                hash,
              }));
              blobIndex += hashes.length;

              if (beaconClient) {
                console.log(`Fetching blobs for transaction: ${tx.hash}`);
                const blobs = await beaconClient.getBlobs(
                  block.timestamp,
                  hashes.map((h) => h.index)
                );

                for (const blob of blobs) {
                  datas.push(blob.data);
                }
              }
            }

            console.log(`Parsing frames for transaction: ${tx.hash}`);
            let frames: Frame[] = [];
            for (const data of datas) {
              try {
                const parsedFrames = parseFrames(data, block.number);
                frames = frames.concat(parsedFrames);
              } catch (err) {
                console.error(
                  `Failed to parse frames for transaction ${tx.hash}:`,
                  err
                );
              }
            }

            const txMetadata = {
              txIndex: tx.index,
              inboxAddr: tx.to,
              blockNumber: block.number,
              blockHash: block.hash,
              blockTime: block.timestamp,
              chainId: config.chainId,
              sender,
              validSender: true,
              tx,
              frames: frames.map((frame) => ({
                id: Buffer.from(frame.id).toString("hex"),
                data: uint8ArrayToBase64(frame.data),
                isLast: frame.isLast,
                frameNumber: frame.frameNumber,
                inclusionBlock: frame.inclusionBlock,
              })),
            };

            const filename = path.join(config.outDirectory, `${tx.hash}.json`);
            console.log(`Writing transaction metadata to file: ${filename}`);
            fs.writeFileSync(filename, JSON.stringify(txMetadata, null, 2));
          } else {
            blobIndex += tx.blobVersionedHashes?.length || 0;
          }
        }
      } catch (err) {
        console.error(`Failed to process block ${i}:`, err);
      }
    }
  });

program
  .command("reassemble")
  .description(
    "Reassembles channels from fetched batch transactions and decode batches"
  )
  .option(
    "--in <string>",
    "Cache directory for the found transactions",
    "/tmp/batch_decoder/transactions_cache"
  )
  .option(
    "--out <string>",
    "Cache directory for the found channels",
    "/tmp/batch_decoder/channel_cache"
  )
  .option(
    "--l2-chain-id <number>",
    "L2 chain id for span batch derivation. Default value from op-mainnet.",
    parseInt,
    10
  )
  .option(
    "--l2-genesis-timestamp <number>",
    "L2 genesis time for span batch derivation. Default value from op-mainnet.",
    parseInt,
    1686068903
  )
  .option(
    "--l2-block-time <number>",
    "L2 block time for span batch derivation. Default value from op-mainnet.",
    parseInt,
    2
  )
  .option(
    "--inbox <string>",
    "Batch Inbox Address. Default value from op-mainnet.",
    "0xFF00000000000000000000000000000000000010"
  )
  .action(async (options) => {
    console.log("Starting reassemble command with options:", options);

    const config: ReassembleConfig = {
      batchInbox: options.inbox,
      inDirectory: options.in,
      outDirectory: options.out,
      l2ChainId: options.l2ChainId,
      l2GenesisTime: options.l2GenesisTimestamp,
      l2BlockTime: options.l2BlockTime,
    };

    console.log("Reassembling channels with config:", config);

    const frameFiles = fs
      .readdirSync(config.inDirectory)
      .filter((file) => file.endsWith(".json"));
    const channelMap: { [channelId: string]: Channel } = {};

    for (const file of frameFiles) {
      console.log(`Processing frame file: ${file}`);
      const filePath = path.join(config.inDirectory, file);
      const txMetadata = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const framesData = txMetadata.frames;

      for (const frameData of framesData) {
        const frame: Frame = {
          id: Buffer.from(frameData.id, "hex"),
          frameNumber: frameData.frameNumber,
          data: Buffer.from(frameData.data, "base64"),
          isLast: frameData.isLast,
          inclusionBlock: frameData.inclusionBlock,
        };
        const channelId = Buffer.from(frame.id).toString("hex");

        if (!channelMap[channelId]) {
          console.log(`Creating new channel for ID: ${channelId}`);
          channelMap[channelId] = new Channel(channelId, frame.inclusionBlock);
        }

        try {
          channelMap[channelId].addFrame(frame);
        } catch (err) {
          console.error(`Failed to add frame to channel ${channelId}:`, err);
        }
      }
    }

    if (!fs.existsSync(config.outDirectory)) {
      fs.mkdirSync(config.outDirectory, { recursive: true });
    }

    for (const channelId in channelMap) {
      console.log(`Processing channel: ${channelId}`);
      const channel = channelMap[channelId];

      if (!channel.isReady()) {
        console.warn(`Channel ${channelId} is not ready.`);
        continue;
      }

      const channelFilePath = path.join(
        config.outDirectory,
        `${channelId}.json`
      );

      // Collect frames metadata
      const framesMetadata = Array.from(channel.inputs.values()).map(
        (frame) => {
          return {
            id: Buffer.from(frame.id).toString("hex"),
            frameNumber: frame.frameNumber,
            inclusionBlock: frame.inclusionBlock,
            isLast: frame.isLast,
            data: Buffer.from(frame.data).toString("base64"),
          };
        }
      );

      // Read batches from channel
      const reader = channel.reader();

      const batches = [];
      const batchTypes = [];
      const comprAlgos = [];
      let invalidBatches = false;

      try {
        // By default this is after fjord, no need to keep compatibility for old op versions
        const readBatch = await batchReader(reader);
        let batchData: BatchData | null;
        while ((batchData = await readBatch())) {
          if (batchData.batchType === SpanBatchType) {
            const spanBatch = batchData.inner as RawSpanBatch;
            batchData.inner = await spanBatch.derive(config.l2ChainId, config.l2GenesisTime, ethers.toBigInt(config.l2ChainId))
          }
          batches.push(batchData.inner);
          batchTypes.push(batchData.batchType);
          if (batchData.comprAlgo) {
            comprAlgos.push(batchData.comprAlgo);
          }
        }
      } catch (err) {
        console.error(`Error reading batches for channel ${channelId}:`, err);
        invalidBatches = true;
      }

      const channelMetadata = {
        id: channelId,
        isReady: channel.isReady(),
        invalidFrames: false,
        invalidBatches: invalidBatches,
        frames: framesMetadata,
        batches,
        batchTypes: batchTypes,
        comprAlgos: comprAlgos,
      };

      function customReplacer(key: string, value: any) {
        if (typeof value === 'bigint') {
          return value.toString();
        }

        if (value && value.type && value.type === 'Buffer') {
          return Buffer.from(value.data).toString('hex');
        }

        return value;
      }

      fs.writeFileSync(
        channelFilePath,
        JSON.stringify(channelMetadata, customReplacer, 2)
      );
      console.log(`Channel data written to ${channelFilePath}`);
    }
  });

program.parse(process.argv);
