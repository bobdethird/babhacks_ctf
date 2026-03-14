import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const suiClient = new SuiGrpcClient({
	network: 'testnet',
	baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const PACKAGE_ID = '0xaff30ff9a4b40845d8bdc91522a2b8e8e542ee41c0855f5cb21a652a00c45e96';
const DEPLOY_DIGEST = '2tyDGac3iD3WuUvuqW7yZ2qdVMwxZ8gJ4vxfojhnQWzp';
const CLOCK = '0x6';
const SHIELD_THRESHOLD = 12;
const COOLDOWN_MS = 600_000; // 10 minutes

async function findArena(): Promise<string> {
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
		if (!(obj instanceof Error) && obj.type.includes('Arena')) {
			return obj.objectId;
		}
	}
	throw new Error('Arena not found');
}

async function executeAndReport(label: string, tx: Transaction) {
	const result = await suiClient.signAndExecuteTransaction({
		transaction: tx,
		signer: keypair,
		include: { effects: true },
	});

	if (result.$kind === 'Transaction' && result.Transaction.status.success) {
		console.log(`${label}: OK (${result.Transaction.digest})`);
		return true;
	} else {
		const err = result.$kind === 'FailedTransaction'
			? result.FailedTransaction.status
			: result.Transaction.status;
		console.error(`${label}: FAILED`, JSON.stringify(err));
		return false;
	}
}

(async () => {
	const address = keypair.getPublicKey().toSuiAddress();
	console.log('Address:', address);

	const arenaId = await findArena();
	console.log('Arena:', arenaId);

	// Check deadline
	const deadlineMs = 1772974800000;
	const now = Date.now();
	if (now > deadlineMs) {
		console.log(`\nArena deadline passed on ${new Date(deadlineMs).toISOString()}.`);
		console.log('This challenge may not be completable unless the deadline is extended.');
		console.log('Attempting anyway in case on-chain clock differs...\n');
	}

	// Step 1: Register
	console.log('Step 1: Registering...');
	const regTx = new Transaction();
	regTx.moveCall({
		target: `${PACKAGE_ID}::sabotage_arena::register`,
		arguments: [regTx.object(arenaId), regTx.object(CLOCK)],
	});
	try {
		const registered = await executeAndReport('Register', regTx);
		if (!registered) {
			console.log('Registration failed. You may already be registered or the arena is closed.');
			return;
		}
	} catch (e: any) {
		if (e.message?.includes('abort code: 5')) {
			console.log('Arena is closed (deadline passed). Cannot complete this challenge.');
			return;
		}
		if (e.message?.includes('abort code: 0')) {
			console.log('Already registered. Continuing...');
		} else {
			throw e;
		}
	}

	// Step 2: Build shield to threshold
	for (let i = 1; i <= SHIELD_THRESHOLD; i++) {
		if (i > 1) {
			const waitSec = Math.ceil(COOLDOWN_MS / 1000) + 10;
			console.log(`Waiting ${waitSec}s for cooldown (build ${i}/${SHIELD_THRESHOLD})...`);
			await new Promise(r => setTimeout(r, (COOLDOWN_MS + 10000)));
		}

		console.log(`Building shield ${i}/${SHIELD_THRESHOLD}...`);
		const buildTx = new Transaction();
		buildTx.moveCall({
			target: `${PACKAGE_ID}::sabotage_arena::build`,
			arguments: [buildTx.object(arenaId), buildTx.object(CLOCK)],
		});
		const built = await executeAndReport(`Build ${i}`, buildTx);
		if (!built) {
			console.log('Build failed. Another player may have attacked you or cooldown active.');
		}
	}

	// Step 3: Claim flag
	console.log('\nClaiming flag...');
	const claimTx = new Transaction();
	const flag = claimTx.moveCall({
		target: `${PACKAGE_ID}::sabotage_arena::claim_flag`,
		arguments: [claimTx.object(arenaId), claimTx.object(CLOCK)],
	});
	claimTx.transferObjects([flag], address);
	await executeAndReport('Claim flag', claimTx);
})();
