import { Question } from './utils/dns/Question.js';
import { Message } from './utils/dns/Message.js';
import { DnssecRecordType } from './records/DnssecRecordType.js';
import {
  augmentFailureResult,
  type ChainVerificationResult,
  type VerificationResult,
} from './securityStatusResults.js';
import { SecurityStatus } from './SecurityStatus.js';
import { Zone } from './Zone.js';
import type { DatePeriod } from './dates.js';
import { SignedRrSet } from './SignedRrSet.js';
import type { Resolver } from './Resolver.js';
import type { DnsClass } from './utils/dns/ianaClasses.js';
import type { DsData } from './records/DsData.js';
import type { RrSet } from './utils/dns/RrSet.js';
import { getZonesInName } from './utils/dns/name.js';

interface MessageByKey {
  readonly [key: string]: Message | undefined;
}

type FinalResolver = (question: Question) => Promise<Message>;

async function retrieveZoneMessages(
  zoneNames: readonly string[],
  recordType: DnssecRecordType,
  classType: DnsClass,
  resolver: FinalResolver,
): Promise<MessageByKey> {
  const question = new Question('.', recordType, classType);

  const promises = zoneNames.map(async (zoneName) => {
    const message = await resolver(question.shallowCopy({ name: zoneName }));
    return { key: `${zoneName}/${recordType}`, value: message };
  });
  const results = await Promise.all(promises);
  const messageByKey: { [key: string]: any } = {};
  results.forEach(({ key, value }) => {
    messageByKey[key] = value;
  });
  return messageByKey as MessageByKey;
}

export class UnverifiedChain {
  public static initFromMessages(query: Question, messages: readonly Message[]): UnverifiedChain {
    const allMessages = messages.reduce<MessageByKey>((accumulator, message) => {
      if (message.questions.length === 0) {
        return accumulator;
      }
      const [question] = message.questions;
      const { key } = question;
      return { ...accumulator, [key]: message };
    }, {});
    const zoneNames = getZonesInName(query.name);
    const messageByKey = zoneNames.reduce<MessageByKey>((accumulator, zoneName) => {
      const dsKey = `${zoneName}/${DnssecRecordType.DS}`;
      const dsMessage = zoneName === '.' ? null : allMessages[dsKey];
      const dnskeyKey = `${zoneName}/${DnssecRecordType.DNSKEY}`;
      return {
        ...accumulator,
        ...(dsMessage ? { [dsKey]: dsMessage } : {}),
        ...(dnskeyKey in allMessages ? { [dnskeyKey]: allMessages[dnskeyKey] } : {}),
      };
    }, {});

    const queryResponse = allMessages[query.key];
    if (!queryResponse) {
      throw new Error(`At least one message must answer ${query.key}`);
    }

    return new UnverifiedChain(query, queryResponse, messageByKey);
  }

  public static async retrieve(question: Question, resolver: Resolver): Promise<UnverifiedChain> {
    const finalResolver: FinalResolver = async (currentQuestion) => {
      const message = await resolver(currentQuestion);
      return message instanceof Buffer ? Message.deserialise(message) : message;
    };
    const zoneNames = getZonesInName(question.name);

    const [dnskeyMessages, dsMessages, response] = await Promise.all([
      retrieveZoneMessages(
        zoneNames,
        DnssecRecordType.DNSKEY,
        question.classId,
        finalResolver,
      ),
      retrieveZoneMessages(
        zoneNames.slice(1), // Skip the root DS
        DnssecRecordType.DS,
        question.classId,
        finalResolver,
      ),
      finalResolver(question),
    ]);

    const zoneMessageByKey: MessageByKey = { ...dnskeyMessages, ...dsMessages };
    return new UnverifiedChain(question, response, zoneMessageByKey);
  }

  protected constructor(
    public readonly query: Question,
    public readonly response: Message,
    public readonly zoneMessageByKey: MessageByKey,
  ) {}

  public verify(datePeriod: DatePeriod, trustAnchors: readonly DsData[]): ChainVerificationResult {
    const rootZoneResult = this.getRootZone(trustAnchors, datePeriod);
    if (rootZoneResult.status !== SecurityStatus.SECURE) {
      return rootZoneResult;
    }

    const answers = SignedRrSet.initFromRecords(this.query, this.response.answers);
    const apexZoneName = answers.signerNames[0] ?? answers.rrset.name;
    const zonesResult = this.getZones(rootZoneResult.result, apexZoneName, datePeriod);
    if (zonesResult.status !== SecurityStatus.SECURE) {
      return zonesResult;
    }

    return this.verifyAnswers(answers, zonesResult.result, datePeriod);
  }

  protected getRootZone(
    trustAnchors: readonly DsData[],
    datePeriod: DatePeriod,
  ): VerificationResult<Zone> {
    const rootDnskeyKey = `./${DnssecRecordType.DNSKEY}`;
    const rootDnskeyResponse = this.zoneMessageByKey[rootDnskeyKey];
    if (!rootDnskeyResponse) {
      return {
        status: SecurityStatus.INDETERMINATE,
        reasonChain: ['Cannot initialise root zone without a DNSKEY response'],
      };
    }
    const result = Zone.initRoot(rootDnskeyResponse, trustAnchors, datePeriod);
    if (result.status !== SecurityStatus.SECURE) {
      return augmentFailureResult(result, 'Got invalid DNSKEY for root zone');
    }
    return result;
  }

  protected getZones(
    rootZone: Zone,
    apexZoneName: string,
    datePeriod: DatePeriod,
  ): VerificationResult<readonly Zone[]> {
    let zones = [rootZone];
    for (const zoneName of getZonesInName(apexZoneName, false)) {
      const dnskeyKey = `${zoneName}/${DnssecRecordType.DNSKEY}`;
      const dnskeyResponse = this.zoneMessageByKey[dnskeyKey];
      if (!dnskeyResponse) {
        return {
          status: SecurityStatus.INDETERMINATE,
          reasonChain: [`Cannot verify zone ${zoneName} without a DNSKEY response`],
        };
      }
      const dsKey = `${zoneName}/${DnssecRecordType.DS}`;
      const dsResponse = this.zoneMessageByKey[dsKey];
      if (dsResponse === undefined) {
        return {
          status: SecurityStatus.INDETERMINATE,
          reasonChain: [`Cannot verify zone ${zoneName} without a DS response`],
        };
      }
      const parent = zones[zones.length - 1];
      const zoneResult = parent.initChild(zoneName, dnskeyResponse, dsResponse, datePeriod);
      if (zoneResult.status !== SecurityStatus.SECURE) {
        return augmentFailureResult(zoneResult, `Failed to verify zone ${zoneName}`);
      }
      const zone = zoneResult.result;

      zones = [...zones, zone];
    }
    return { status: SecurityStatus.SECURE, result: zones };
  }

  protected verifyAnswers(
    answers: SignedRrSet,
    zones: readonly Zone[],
    datePeriod: DatePeriod,
  ): VerificationResult<RrSet> {
    const apexZone = zones[zones.length - 1];
    if (!apexZone.verifyRrset(answers, datePeriod)) {
      return {
        status: SecurityStatus.BOGUS,
        reasonChain: ['Query response does not have a valid signature'],
      };
    }

    return {
      status: SecurityStatus.SECURE,
      result: answers.rrset,
    };
  }
}
