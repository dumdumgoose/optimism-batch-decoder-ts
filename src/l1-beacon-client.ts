import axios from 'axios';
import { Blob } from './blob';

export class L1BeaconClient {
    private baseUrl: string;
  
    constructor(baseUrl: string) {
      this.baseUrl = baseUrl;
    }
  
    async checkVersion(): Promise<void> {
      try {
        console.log('Checking L1 Beacon API version...');
        const response = await axios.get(`${this.baseUrl}/eth/v1/node/version`);
        console.log('Beacon Node Version:', response.data.data.version);
      } catch (error) {
        console.error('Failed to check L1 Beacon API version:', error);
        throw error;
      }
    }
  
    async getBlobs(timestamp: number, indices: number[]): Promise<any[]> {
      try {
        const slot = await (await this.getTimeToSlotFn())(timestamp);
        console.log(`Fetching blobs for slot ${slot} with blob indices:`, indices);
        const sidecars = await this.getBlobSidecars(slot, indices);
        const blobs = sidecars.map((sidecar: any) => {
          const blob = new Blob(sidecar.blob);
        //   console.log(`Blob data: ${Buffer.from(blob.toData()).toString('hex')}`);
          return {
            data: blob.toData(),
            kzgCommitment: sidecar.kzg_commitment,
            kzgProof: sidecar.kzg_proof,
          };
        });
        console.log(`Fetched blobs for slot ${slot}`);
        return blobs;
      } catch (error) {
        console.error('Failed to fetch blobs:', error);
        throw error;
      }
    }
  
    async getBlobSidecars(slot: number, indices: number[]): Promise<any[]> {
      try {
        console.log(`Fetching blob sidecars for slot ${slot} with indices:`, indices);
        const response = await axios.get(`${this.baseUrl}/eth/v1/beacon/blob_sidecars/${slot}`, {
          params: { indices: indices.join(',') },
        });
        console.log(`Fetched blob sidecars for slot ${slot}`);
        return response.data.data;
      } catch (error) {
        console.error('Failed to fetch blob sidecars:', error);
        throw error;
      }
    }
  
    async getTimeToSlotFn(): Promise<(timestamp: number) => number> {
      try {
        console.log('Getting time to slot function...');
        const genesisResponse = await axios.get(`${this.baseUrl}/eth/v1/beacon/genesis`);
        const configResponse = await axios.get(`${this.baseUrl}/eth/v1/config/spec`);
  
        const genesisTime = Number(genesisResponse.data.data.genesis_time);
        const secondsPerSlot = Number(configResponse.data.data.SECONDS_PER_SLOT);
  
        return (timestamp: number) => {
          if (timestamp < genesisTime) {
            throw new Error(`Provided timestamp (${timestamp}) precedes genesis time (${genesisTime})`);
          }
          return Math.floor((timestamp - genesisTime) / secondsPerSlot);
        };
      } catch (error) {
        console.error('Failed to get time to slot function:', error);
        throw error;
      }
    }
  }
  