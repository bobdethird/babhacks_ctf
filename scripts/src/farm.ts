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
const EXPLOIT_PACKAGE_ID = '0xa5c5d58e3d2422f167ab715e3df70deb23b7a4ac5ac47f9ff6f8b946641282db';
const DEPLOY_DIGEST = '2tyDGac3iD3WuUvuqW7yZ2qdVMwxZ8gJ4vxfojhnQWzp';
const USDC_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const CLOCK = '0x6';
const RANDOM = '0x8';

const MERCHANT_COST = 3_849_000;
const LOOTBOX_COST = 12_000_000;
const MOVING_WINDOW_BATCH = 50;
const STAKING_RECEIPTS = 168;
const STAKE_AMOUNT = 6_000_000;

const address = keypair.getPublicKey().toSuiAddress();
let totalFlags = 0;

function log(tag: string, msg: string) {
	const ts = new Date().toISOString().slice(11, 19);
	console.log(`[${ts}][${tag}] ${msg}`);
}

function addFlags(n: number, source: string) {
	totalFlags += n;
	log('SCORE', `+${n} from ${source} | Total: ${totalFlags} flags`);
}

// ─── Moving Window: batch-claim free flags during open windows ───

function getWindowInfo(): { open: boolean; waitMs: number; remainingMs: number } {
	const now = Math.floor(Date.now() / 1000);
	const t = now % 3600;

	if (t >= 0 && t < 300) {
		return { open: true, waitMs: 0, remainingMs: (300 - t) * 1000 };
	}
	if (t >= 1800 && t < 2100) {
		return { open: true, waitMs: 0, remainingMs: (2100 - t) * 1000 };
	}

	const waitSec = t < 1800 ? 1800 - t : 3600 - t;
	return { open: false, waitMs: waitSec * 1000, remainingMs: 0 };
}

async function farmMovingWindow() {
	log('MW', 'Moving window farmer started');
	while (true) {
		const info = getWindowInfo();
		if (!info.open) {
			const waitMin = Math.ceil(info.waitMs / 60000);
			log('MW', `Window closed. Next opens in ${waitMin}min. Sleeping...`);
			await sleep(info.waitMs + 3000);
			continue;
		}

		log('MW', `Window OPEN! ${Math.floor(info.remainingMs / 1000)}s remaining. Batch claiming ${MOVING_WINDOW_BATCH}...`);
		try {
			const tx = new Transaction();
			tx.setGasBudget(500_000_000);
			const flags = [];
			for (let i = 0; i < MOVING_WINDOW_BATCH; i++) {
				const flag = tx.moveCall({
					target: `${PACKAGE_ID}::moving_window::extract_flag`,
					arguments: [tx.object(CLOCK)],
				});
				flags.push(flag);
			}
			tx.transferObjects(flags, address);

			const result = await suiClient.signAndExecuteTransaction({
				transaction: tx, signer: keypair, include: { effects: true },
			});
			if (result.$kind === 'Transaction' && result.Transaction.status.success) {
				addFlags(MOVING_WINDOW_BATCH, 'moving_window');
				log('MW', `Batch OK: ${result.Transaction.digest}`);
			} else {
				log('MW', `Batch FAILED`);
			}
		} catch (e: any) {
			log('MW', `Error: ${e.message?.slice(0, 120)}`);
		}
		await sleep(2000);
	}
}

// ─── Staking: cycle stake→wait→claim→repeat ───

async function findStakingPool(): Promise<string> {
	const txResult = await suiClient.getTransaction({ digest: DEPLOY_DIGEST, include: { effects: true } });
	const tx = txResult.$kind === 'Transaction' ? txResult.Transaction : txResult.FailedTransaction;
	if (!tx?.effects) throw new Error('Cannot fetch deploy tx');
	const created = tx.effects.changedObjects.filter(o => o.idOperation === 'Created' && o.outputOwner?.$kind === 'Shared');
	const { objects } = await suiClient.getObjects({ objectIds: created.map(o => o.objectId) });
	for (const obj of objects) {
		if (!(obj instanceof Error) && obj.type.includes('StakingPool')) return obj.objectId;
	}
	throw new Error('StakingPool not found');
}

async function getAllReceipts(): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	let hasNext = true;
	while (hasNext) {
		const r = await suiClient.listOwnedObjects({
			owner: address, type: `${PACKAGE_ID}::staking::StakeReceipt`, cursor,
		});
		for (const o of r.objects) ids.push(o.objectId);
		hasNext = r.hasNextPage;
		cursor = r.cursor;
	}
	return ids;
}

async function farmStaking() {
	log('STK', 'Staking farmer started');
	const poolId = await findStakingPool();

	while (true) {
		const receipts = await getAllReceipts();

		if (receipts.length >= STAKING_RECEIPTS) {
			log('STK', `Found ${receipts.length} receipts. Attempting claim...`);
			try {
				const tx = new Transaction();
				tx.setGasBudget(500_000_000);
				const updated = receipts.map(id =>
					tx.moveCall({ target: `${PACKAGE_ID}::staking::update_receipt`, arguments: [tx.object(id), tx.object(CLOCK)] })
				);
				let merged = updated[0];
				for (let i = 1; i < updated.length; i++) {
					merged = tx.moveCall({
						target: `${PACKAGE_ID}::staking::merge_receipts`,
						arguments: [merged, updated[i], tx.object(CLOCK)],
					});
				}
				const claim = tx.moveCall({
					target: `${PACKAGE_ID}::staking::claim_flag`,
					arguments: [tx.object(poolId), merged, tx.object(CLOCK)],
				});
				tx.transferObjects([claim[0], claim[1]], address);

				const result = await suiClient.signAndExecuteTransaction({
					transaction: tx, signer: keypair, include: { effects: true },
				});
				if (result.$kind === 'Transaction' && result.Transaction.status.success) {
					addFlags(1, 'staking');
					log('STK', `Claimed! ${result.Transaction.digest}. Starting new cycle...`);
				} else {
					log('STK', 'Claim failed (maybe <1hr). Waiting 5min...');
					await sleep(300_000);
					continue;
				}
			} catch (e: any) {
				log('STK', `Claim error: ${e.message?.slice(0, 120)}. Waiting 5min...`);
				await sleep(300_000);
				continue;
			}
		}

		// Phase 1: Stake new receipts
		log('STK', `Staking ${STAKING_RECEIPTS} new receipts...`);
		try {
			const tx = new Transaction();
			tx.setGasBudget(500_000_000);
			const coins = tx.splitCoins(tx.gas, Array(STAKING_RECEIPTS).fill(STAKE_AMOUNT));
			const stakeReceipts = [];
			for (let i = 0; i < STAKING_RECEIPTS; i++) {
				stakeReceipts.push(tx.moveCall({
					target: `${PACKAGE_ID}::staking::stake`,
					arguments: [tx.object(poolId), coins[i], tx.object(CLOCK)],
				}));
			}
			tx.transferObjects(stakeReceipts, address);
			const result = await suiClient.signAndExecuteTransaction({
				transaction: tx, signer: keypair, include: { effects: true },
			});
			if (result.$kind === 'Transaction' && result.Transaction.status.success) {
				log('STK', `Staked! Waiting 65min for maturity...`);
			} else {
				log('STK', 'Stake failed. Retrying in 1min...');
				await sleep(60_000);
				continue;
			}
		} catch (e: any) {
			log('STK', `Stake error: ${e.message?.slice(0, 120)}. Retrying in 1min...`);
			await sleep(60_000);
			continue;
		}

		await sleep(65 * 60 * 1000); // 65 minutes
	}
}

// ─── Merchant: batch-buy flags with USDC ───

async function farmMerchant() {
	log('MER', 'Merchant farmer started');

	while (true) {
		const { balance } = await suiClient.getBalance({ owner: address, coinType: USDC_TYPE });
		const usdc = BigInt(balance.coinBalance);
		const canBuy = Number(usdc / BigInt(MERCHANT_COST));

		if (canBuy <= 0) {
			log('MER', `USDC balance: ${usdc}. Need ${MERCHANT_COST} per flag. Waiting 2min...`);
			await sleep(120_000);
			continue;
		}

		const batchSize = Math.min(canBuy, 4); // conservative batch
		log('MER', `Buying ${batchSize} merchant flags (USDC: ${usdc})...`);

		try {
			const coins = await suiClient.listCoins({ owner: address, coinType: USDC_TYPE });
			if (coins.objects.length === 0) { await sleep(30_000); continue; }

			const tx = new Transaction();
			tx.setGasBudget(200_000_000);
			const flags = [];
			for (let i = 0; i < batchSize; i++) {
				const [payment] = tx.splitCoins(coins.objects[0].objectId, [MERCHANT_COST]);
				const flag = tx.moveCall({
					target: `${PACKAGE_ID}::merchant::buy_flag`,
					arguments: [payment],
				});
				flags.push(flag);
			}
			tx.transferObjects(flags, address);

			const result = await suiClient.signAndExecuteTransaction({
				transaction: tx, signer: keypair, include: { effects: true },
			});
			if (result.$kind === 'Transaction' && result.Transaction.status.success) {
				addFlags(batchSize, 'merchant');
				log('MER', `Bought ${batchSize}! ${result.Transaction.digest}`);
			} else {
				log('MER', 'Buy failed');
			}
		} catch (e: any) {
			log('MER', `Error: ${e.message?.slice(0, 120)}`);
		}
		await sleep(5000);
	}
}

// ─── Lootboxes: use remaining USDC after merchant is done ───

async function farmLootboxes() {
	log('LB', 'Lootbox farmer started. Waiting 30s for merchant to use USDC first...');
	await sleep(30_000);

	while (true) {
		const { balance } = await suiClient.getBalance({ owner: address, coinType: USDC_TYPE });
		const usdc = BigInt(balance.coinBalance);

		if (usdc < BigInt(LOOTBOX_COST)) {
			log('LB', `USDC: ${usdc}. Need ${LOOTBOX_COST}. Waiting 2min...`);
			await sleep(120_000);
			continue;
		}

		log('LB', `Trying lootbox (USDC: ${usdc})...`);
		try {
			const coins = await suiClient.listCoins({ owner: address, coinType: USDC_TYPE });
			if (coins.objects.length === 0) { await sleep(10_000); continue; }

			const tx = new Transaction();
			const [payment] = tx.splitCoins(coins.objects[0].objectId, [LOOTBOX_COST]);
			tx.moveCall({
				target: `${EXPLOIT_PACKAGE_ID}::lootbox_exploit::try_open`,
				arguments: [payment, tx.object(RANDOM)],
			});

			const result = await suiClient.signAndExecuteTransaction({
				transaction: tx, signer: keypair, include: { effects: true },
			});
			if (result.$kind === 'Transaction' && result.Transaction.status.success) {
				addFlags(1, 'lootbox');
				log('LB', `Won! ${result.Transaction.digest}`);
			} else {
				log('LB', 'No flag (aborted, USDC returned)');
			}
		} catch (e: any) {
			log('LB', `No flag this attempt`);
		}
		await sleep(3000);
	}
}

// ─── Main ───

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
	console.log('═══════════════════════════════════════');
	console.log('  CTF FLAG FARMER - Parallel Edition');
	console.log('═══════════════════════════════════════');
	console.log(`Address: ${address}`);

	const { balance: suiBalance } = await suiClient.getBalance({ owner: address });
	const { balance: usdcBalance } = await suiClient.getBalance({ owner: address, coinType: USDC_TYPE });
	console.log(`SUI: ${BigInt(suiBalance.coinBalance) / 1_000_000_000n} SUI`);
	console.log(`USDC: ${BigInt(usdcBalance.coinBalance) / 1_000_000n} USDC`);
	console.log('');
	console.log('Priority: Moving Window (free) > Staking (free, 1hr) > Merchant (3.85 USDC) > Lootbox (12 USDC)');
	console.log('All running in parallel. Ctrl+C to stop.');
	console.log('═══════════════════════════════════════\n');

	await Promise.all([
		farmMovingWindow(),
		farmStaking(),
		farmMerchant(),
		farmLootboxes(),
	]);
})();
