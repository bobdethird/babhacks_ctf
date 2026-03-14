import { SuiGrpcClient } from '@mysten/sui/grpc';
import keyPairJson from "../keypair.json" with { type: "json" };

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
const OLD_PKG = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const NEW_PKG = '0xaff30ff9a4b40845d8bdc91522a2b8e8e542ee41c0855f5cb21a652a00c45e96';
const owner = keyPairJson.publicAddress;

async function countFlags(pkg: string): Promise<number> {
	let count = 0, cursor: string | null = null, hasNext = true;
	while (hasNext) {
		const r = await client.listOwnedObjects({ owner, type: `${pkg}::flag::Flag`, cursor, limit: 50 });
		count += r.objects.length;
		hasNext = r.hasNextPage;
		cursor = r.cursor;
	}
	return count;
}

(async () => {
	const [oldCount, newCount] = await Promise.all([countFlags(OLD_PKG), countFlags(NEW_PKG)]);

	console.log('═══════════════════════════════════');
	console.log('  ON-CHAIN FLAG COUNT');
	console.log('═══════════════════════════════════');
	console.log(`Old package (0x936...): ${oldCount} flags`);
	console.log(`New package (0xaff...): ${newCount} flags`);
	console.log('───────────────────────────────────');
	console.log(`TOTAL: ${oldCount + newCount} flags`);
	console.log('═══════════════════════════════════');
})();
