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
const COST_PER_FLAG = 3_849_000; // 3.849 USDC (6 decimals)

(async () => {
	const address = keypair.getPublicKey().toSuiAddress();
	console.log('Address:', address);

	// Discover the USDC type from the contract's buy_flag function signature
	const fnInfo = await suiClient.getMoveFunction({
		packageId: PACKAGE_ID,
		moduleName: 'merchant',
		name: 'buy_flag',
	});
	console.log('buy_flag parameters:', JSON.stringify(fnInfo.function.parameters, null, 2));

	// Extract USDC type from the first parameter (Coin<USDC>)
	const coinParam = fnInfo.function.parameters[0];
	let usdcType: string | undefined;
	if (coinParam.body.$kind === 'datatype') {
		const innerType = coinParam.body.datatype.typeParameters[0];
		if (innerType.$kind === 'datatype') {
			usdcType = innerType.datatype.typeName;
		}
	}

	if (!usdcType) {
		throw new Error('Could not determine USDC type from contract');
	}
	console.log('USDC type:', usdcType);

	// Check USDC balance
	const { balance } = await suiClient.getBalance({
		owner: address,
		coinType: usdcType,
	});
	console.log('USDC balance:', balance.coinBalance);

	if (BigInt(balance.coinBalance) < BigInt(COST_PER_FLAG)) {
		console.log(`\nInsufficient USDC. Need ${COST_PER_FLAG} (${COST_PER_FLAG / 1_000_000} USDC).`);
		console.log(`Get testnet USDC at https://faucet.circle.com/ (select Sui testnet)`);
		console.log(`Your address: ${address}`);
		return;
	}

	// Find USDC coins
	const coins = await suiClient.listCoins({
		owner: address,
		coinType: usdcType,
	});

	if (coins.objects.length === 0) {
		throw new Error('No USDC coins found');
	}

	const tx = new Transaction();

	// Split exact payment amount from available USDC
	const [paymentCoin] = tx.splitCoins(coins.objects[0].objectId, [COST_PER_FLAG]);

	const flag = tx.moveCall({
		target: `${PACKAGE_ID}::merchant::buy_flag`,
		arguments: [paymentCoin],
	});

	tx.transferObjects([flag], address);

	console.log('Buying flag...');
	const result = await suiClient.signAndExecuteTransaction({
		transaction: tx,
		signer: keypair,
		include: { effects: true },
	});

	if (result.$kind === 'Transaction') {
		console.log('TX digest:', result.Transaction.digest);
		console.log('Merchant flag claimed!');
	} else {
		console.error('Failed:', result.FailedTransaction?.status);
	}
})();
