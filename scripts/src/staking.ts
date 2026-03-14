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
const DEPLOY_DIGEST = 'FDM3FUBJStmycZp1tb7ucVH7oA66iVo1uVHoy1iA8he1';
const CLOCK = '0x6';
const NUM_RECEIPTS = 168;
const STAKE_AMOUNT = 6_000_000; // 0.006 SUI per receipt, ~1.008 SUI total

async function findStakingPool(): Promise<string> {
	const txResult = await suiClient.getTransaction({
		digest: DEPLOY_DIGEST,
		include: { effects: true },
	});

	const tx = txResult.$kind === 'Transaction' ? txResult.Transaction : txResult.FailedTransaction;
	if (!tx?.effects) throw new Error('Could not fetch deploy transaction');

	const createdShared = tx.effects.changedObjects.filter(
		obj => obj.idOperation === 'Created' && obj.outputOwner?.$kind === 'Shared'
	);

	const { objects } = await suiClient.getObjects({
		objectIds: createdShared.map(o => o.objectId),
	});

	for (const obj of objects) {
		if (!(obj instanceof Error) && obj.type.includes('StakingPool')) {
			return obj.objectId;
		}
	}
	throw new Error('StakingPool not found');
}

async function getAllReceipts(owner: string): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const result = await suiClient.listOwnedObjects({
			owner,
			type: `${PACKAGE_ID}::staking::StakeReceipt`,
			cursor,
		});
		for (const obj of result.objects) {
			ids.push(obj.objectId);
		}
		hasNextPage = result.hasNextPage;
		cursor = result.cursor;
	}
	return ids;
}

(async () => {
	const address = keypair.getPublicKey().toSuiAddress();
	console.log('Address:', address);

	const { balance } = await suiClient.getBalance({ owner: address });
	console.log('SUI Balance:', BigInt(balance.coinBalance) / 1_000_000_000n, 'SUI',
		`(${balance.coinBalance} MIST)`);

	const stakingPoolId = await findStakingPool();
	console.log('StakingPool:', stakingPoolId);

	const receipts = await getAllReceipts(address);
	console.log('Existing receipts:', receipts.length);

	if (receipts.length < NUM_RECEIPTS) {
		console.log(`\n=== Phase 1: Staking ${NUM_RECEIPTS} receipts ===`);

		const tx = new Transaction();
		tx.setGasBudget(500_000_000);

		const coins = tx.splitCoins(tx.gas, Array(NUM_RECEIPTS).fill(STAKE_AMOUNT));

		const stakeReceipts = [];
		for (let i = 0; i < NUM_RECEIPTS; i++) {
			const receipt = tx.moveCall({
				target: `${PACKAGE_ID}::staking::stake`,
				arguments: [tx.object(stakingPoolId), coins[i], tx.object(CLOCK)],
			});
			stakeReceipts.push(receipt);
		}

		tx.transferObjects(stakeReceipts, address);

		console.log('Executing stake transaction...');
		const result = await suiClient.signAndExecuteTransaction({
			transaction: tx,
			signer: keypair,
			include: { effects: true },
		});

		if (result.$kind === 'Transaction') {
			console.log('TX digest:', result.Transaction.digest);
			console.log('\n==> Wait at least 1 hour (65 min recommended), then run this script again <==');
		} else {
			console.error('Transaction failed:', result.FailedTransaction?.status);
		}
	} else {
		console.log(`\n=== Phase 2: Claiming flag with ${receipts.length} receipts ===`);

		const tx = new Transaction();
		tx.setGasBudget(500_000_000);

		const updated = receipts.map(id =>
			tx.moveCall({
				target: `${PACKAGE_ID}::staking::update_receipt`,
				arguments: [tx.object(id), tx.object(CLOCK)],
			})
		);

		let merged = updated[0];
		for (let i = 1; i < updated.length; i++) {
			merged = tx.moveCall({
				target: `${PACKAGE_ID}::staking::merge_receipts`,
				arguments: [merged, updated[i], tx.object(CLOCK)],
			});
		}

		const claimResult = tx.moveCall({
			target: `${PACKAGE_ID}::staking::claim_flag`,
			arguments: [tx.object(stakingPoolId), merged, tx.object(CLOCK)],
		});

		tx.transferObjects([claimResult[0], claimResult[1]], address);

		console.log('Executing claim transaction...');
		const result = await suiClient.signAndExecuteTransaction({
			transaction: tx,
			signer: keypair,
			include: { effects: true },
		});

		if (result.$kind === 'Transaction') {
			console.log('TX digest:', result.Transaction.digest);
			console.log('Flag claimed successfully!');
		} else {
			console.error('Transaction failed:', result.FailedTransaction?.status);
		}
	}
})();
