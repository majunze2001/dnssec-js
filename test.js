// main.js
import { dnssecLookUp, Question, SecurityStatus } from './build/lib/index.js';
import { DNSoverHTTPS } from 'dohdec';

const doh = new DNSoverHTTPS({ url: 'https://cloudflare-dns.com/dns-query' });

async function getARecord(domain, type) {
  return await dnssecLookUp(new Question(domain, type), async (question) =>
    doh.lookup(question.name, {
      rrtype: question.getTypeName(),
      json: false, // Request DNS message in wire format
      decode: false, // Don't parse the DNS message
      dnssec: true, // Retrieve RRSIG records
      dnssecCheckingDisabled: true, // Disable server-side DNSSEC validation
    }),
  );
}

const [domainName, type] = process.argv.slice(2);
const result = await getARecord(domainName, type);
if (result.status === SecurityStatus.SECURE) {
  //console.log(`${domainName}/${type} =`, result.result);
} else {
  const reason = result.reasonChain.join(', ');
  console.error(`DNSSEC verification for ${domain}/A failed: ${reason}`);
}
