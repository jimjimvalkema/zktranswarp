import { deployPoseidon2Huff } from "@warptoad/gigabridge-js";
import { network } from "hardhat";
//import { leanIMTPoseidon2ContractName, ZKTranscriptLibContractName, PrivateTransferVerifierContractName, TransWarpTokenContractName } from "../src/constants.js";
import { padHex } from "viem";
const { viem } = await network.connect();
const publicClient = await viem.getPublicClient();

export async function main() {
    const [deployer] = await viem.getWalletClients()
    const poseidon2Create2Salt = padHex("0x00", { size: 32 })
    // i hate how i cant deploy shit like this with hardhat ignition!!!
    const {poseidon2HuffDeployTx, poseidon2HuffAddress} = await deployPoseidon2Huff(publicClient, deployer, poseidon2Create2Salt)
    if(poseidon2HuffDeployTx) {
        await publicClient.waitForTransactionReceipt({hash:poseidon2HuffDeployTx, confirmations:5})
        console.log(`deployed at: ${poseidon2HuffDeployTx} at address: ${poseidon2HuffAddress}`)
    } else {
        console.log(`already deployed at address: ${poseidon2HuffAddress}`)
    }
}

await main()