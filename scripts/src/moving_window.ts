import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
	network: 'testnet',
	baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const PACKAGE_ID = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const CLOCK = '0x6';

function isWindowOpen(): { open: boolean; waitMs: number } {
	const now = Math.floor(Date.now() / 1000);
	const timeInHour = now % 3600;

	// Window 1: [0, 300) - first 5 minutes of each hour
	// Window 2: [1800, 2100) - minutes 30:00 to 35:00 of each hour
	if ((timeInHour >= 0 && timeInHour < 300) || (timeInHour >= 1800 && timeInHour < 2100)) {
		return { open: true, waitMs: 0 };
	}

	let waitSeconds: number;
	if (timeInHour < 1800) {
		waitSeconds = 1800 - timeInHour;
	} else {
		waitSeconds = 3600 - timeInHour;
	}
	return { open: false, waitMs: waitSeconds * 1000 };
}

(async () => {
	const address = keypair.getPublicKey().toSuiAddress();
	console.log('Address:', address);

	const { open, waitMs } = isWindowOpen();

	if (!open) {
		const waitMin = Math.ceil(waitMs / 60000);
		console.log(`Window is closed. Next window opens in ~${waitMin} minutes.`);
		console.log('Waiting...');
		await new Promise(resolve => setTimeout(resolve, waitMs + 5000));
	}

	console.log('Window is open! Extracting flag...');

	const tx = new Transaction();
	const flag = tx.moveCall({
		target: `${PACKAGE_ID}::moving_window::extract_flag`,
		arguments: [tx.object(CLOCK)],
	});
	tx.transferObjects([flag], address);

	const result = await suiClient.signAndExecuteTransaction({
		transaction: tx,
		signer: keypair,
		include: { effects: true },
	});

	if (result.$kind === 'Transaction') {
		console.log('TX digest:', result.Transaction.digest);
		console.log('Moving window flag claimed!');
	} else {
		console.error('Failed:', result.FailedTransaction?.status);
	}
})();
