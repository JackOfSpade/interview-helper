import { assert } from './testHelpers.js';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { getRecentLogs } from '../../electron/logger.js';
import { snapshotActiveNodeTasks } from '../../electron/ipc/ipcUtils.js';
import {
  canonicalInterviewJobUrl,
  validInterviewPreparationBrief,
} from '../../src/utils/interviewHelper.js';
import {
  isInterviewHelperNodeId,
  isInterviewHelperSnapshotId,
  loadInterviewHelperCareerSnapshot,
  projectInterviewHelperCareerSnapshot,
  registerInterviewHelperHandlers,
} from '../../electron/ipc/interviewHelper.js';
import { emptyInterviewData } from '../../src/interview-app/sessions.js';

function profileFixture() {
  return {
    identity: { name: 'Ada Example', contacts: [], evidenceSegmentIds: ['segment-0001'] },
    roles: [{
      id: 'role-acme', title: 'Product Manager', employer: 'Acme', startDate: '2021', endDate: 'Present', location: 'Toronto',
      achievementIds: ['achievement-onboarding', 'achievement-platform'], skillIds: ['skill-react'], evidenceSegmentIds: ['segment-0002'],
    }],
    achievements: [
      { id: 'achievement-onboarding', roleId: 'role-acme', claim: 'Improved onboarding conversion by testing a simpler setup flow.', technologies: ['Optimizely'], metrics: [], evidenceSegmentIds: ['segment-0003'] },
      { id: 'achievement-platform', roleId: 'role-acme', claim: 'Led the platform migration with partner teams.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0004'] },
    ],
    projects: [{
      id: 'project-dashboard', roleId: 'role-acme', name: 'Analytics Dashboard', description: 'Built an analytics dashboard for weekly retention reviews.', technologies: ['React'], metrics: [], evidenceSegmentIds: ['segment-0005'],
    }, {
      id: 'project-atlas', roleId: 'role-acme', name: 'Atlas', description: 'Built a private reporting console.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0009'],
    }],
    skills: [
      { id: 'skill-react', name: 'React', category: 'frontend', supportMode: 'direct', indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: ['segment-0006'], directEvidenceSegmentIds: ['segment-0005'] },
      { id: 'skill-cpp', name: 'C++', category: 'language', supportMode: 'direct', indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: ['segment-0008'], directEvidenceSegmentIds: ['segment-0008'] },
      { id: 'skill-prototype', name: 'Prototype', category: 'tool', supportMode: 'direct', indexEligible: false, roleIds: ['role-acme'], evidenceSegmentIds: ['segment-0010'], directEvidenceSegmentIds: ['segment-0010'] },
      { id: 'skill-conditional', name: 'Legacy CMS', category: 'platform', supportMode: 'relationship-qualified', indexEligible: false, roleIds: [], evidenceSegmentIds: ['segment-0007'], directEvidenceSegmentIds: [] },
    ],
    education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
}

const INTERVIEW_SNAPSHOT_ID = 'a'.repeat(64);

function approvedSnapshotFixture() {
  const profile = profileFixture();
  const directSkill = {
    ...profile.skills[0],
    capabilityKind: 'technology',
    supportMode: 'direct',
    directEvidenceSegmentIds: ['segment-0005', 'not-a-segment-id'],
  };
  return {
    snapshotId: INTERVIEW_SNAPSHOT_ID,
    schemaVersion: 6,
    status: 'approved',
    // These must never cross the Interview Helper renderer boundary.
    sources: [{ name: 'Work Experience.md', legacyText: 'RAW_LEGACY_SOURCE_SHOULD_NOT_LEAK' }],
    segments: [{ id: 'segment-0001', text: 'RAW_SEGMENT_SOURCE_SHOULD_NOT_LEAK' }],
    profile: {
      ...profile,
      identity: { name: 'Ada Example', contacts: ['ada@example.test'], evidenceSegmentIds: ['segment-0001'] },
      achievements: [{
        ...profile.achievements[0],
        metrics: [{ label: 'conversion', value: '12', unit: 'percent', evidenceSegmentIds: ['segment-0003'] }],
      }, ...profile.achievements.slice(1)],
      skills: [directSkill, ...profile.skills.slice(1)],
      otherEvidence: [{
        id: 'other-award', kind: 'award', label: 'Delivery recognition', text: 'Recognized for delivery.', evidenceSegmentIds: ['segment-0008'],
      }],
    },
  };
}

function throws(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

function senderEvent() {
  const sender = new EventEmitter();
  sender.id = senderEvent.nextId++;
  sender.isDestroyed = () => false;
  return { sender };
}
senderEvent.nextId = 50_000;

export default [
  {
    name: 'interview helper: renderer and IPC canonicalize repaired job URLs identically',
    run: async () => {
      const { normalizeInterviewPreparationJobUrl } = await import('../../electron/ipc/interviewPreparation.js');
      const urls = [
        ' https://jobs.example.test/openings/42?ref=canvas#details ',
        'https://www.google.com/search?q=Product+Manager&ibp=htl;jobs&htidocid=abc123#htivrt=jobs',
      ];
      for (const input of urls) {
        const renderer = canonicalInterviewJobUrl(input);
        const backend = normalizeInterviewPreparationJobUrl(input);
        assert(renderer && renderer === backend, `renderer and IPC must agree on ${input}`);
        assert(!renderer.includes('#') && !renderer.includes('?ref='), 'canonical job URLs must not retain fragments or arbitrary query metadata');
      }
      const repaired = canonicalInterviewJobUrl(urls[1]);
      assert(repaired === 'https://www.google.com/search?udm=8&htidocid=abc123', 'a genuine Google Jobs card URL must retain only its repaired public Jobs identity');
      for (const unsafe of ['https://jobs.example.test/a\u0085b', 'https://jobs.example.test/a\u202Eb']) {
        assert(canonicalInterviewJobUrl(unsafe) === null && !normalizeInterviewPreparationJobUrl(unsafe), 'C1 and bidi controls must be rejected at both URL boundaries');
      }
    },
  },
  {
    name: 'interview helper: strips secret and tracking URL data at renderer and IPC boundaries',
    run: async () => {
      const { normalizeInterviewPreparationJobUrl } = await import('../../electron/ipc/interviewPreparation.js');
      const privacyCases = [
        ['https://jobs.example.test/openings/42?access_token=top-secret&ref=canvas#candidate@example.test', 'https://jobs.example.test/openings/42'],
        ['https://research.example.test/article?token=abc123&signature=deadbeef&utm_source=email', 'https://research.example.test/article'],
        ['https://jobs.example.test/?email=ada%40example.test', 'https://jobs.example.test/'],
        ['https://jobs.example.test/?signed=private', 'https://jobs.example.test/'],
      ];
      for (const [input, expected] of privacyCases) {
        assert(canonicalInterviewJobUrl(input) === expected, `renderer must redact query/fragment data for ${input}`);
        assert(normalizeInterviewPreparationJobUrl(input) === expected, `IPC must redact query/fragment data for ${input}`);
        assert(!canonicalInterviewJobUrl(input)?.match(/access_token|token|signature|email|utm|private|secret/iu), 'a persisted URL must not retain input secret-like query values');
      }
      const google = 'https://www.google.com/search?q=ada%40example.test&ibp=htl%3Bjobs&udm=8&htidocid=abc_123%3Adef&hl=en-CA&token=secret#docid=abc_123%3Adef';
      const expectedGoogle = 'https://www.google.com/search?udm=8&htidocid=abc_123%3Adef&hl=en-CA';
      assert(canonicalInterviewJobUrl(google) === expectedGoogle && normalizeInterviewPreparationJobUrl(google) === expectedGoogle, 'Google Jobs repair may retain only bounded document identity and locale, never q or arbitrary parameters');
      const malformedGoogleId = 'https://www.google.com/search?udm=8&htidocid=abc%2Fprivate&token=secret';
      assert(canonicalInterviewJobUrl(malformedGoogleId) === 'https://www.google.com/search?udm=8', 'invalid Google document ids must not be persisted');
      const credentialedGoogle = 'https://user:pass@www.google.com/search?udm=8&htidocid=abc123';
      assert(canonicalInterviewJobUrl(credentialedGoogle) === null && !normalizeInterviewPreparationJobUrl(credentialedGoogle), 'credential-bearing inputs must be rejected before Google repair can erase their origin');
    },
  },
  {
    name: 'interview helper: rejects unsafe persisted preparation display text',
    run: () => {
      const bundleId = 'b'.repeat(64);
      const digest = 'c'.repeat(64);
      const brief = {
        version: 1,
        briefId: 'd'.repeat(64),
        createdAt: '2026-10-08T00:00:00.000Z',
        inputs: { careerSnapshotId: INTERVIEW_SNAPSHOT_ID, jobUrlSha256: 'e'.repeat(64), applicationArtifactId: bundleId, applicationArtifactDigest: digest },
        role: { title: 'Café — Product', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
        roleThemes: [], companyFacts: [], recentContext: [], likelyQuestions: [], questionsToAsk: [], applicationPositioning: [], sources: [], warnings: [],
      };
      assert(validInterviewPreparationBrief(brief, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'ordinary non-ASCII letters and punctuation remain valid display text');
      const emptySummary = structuredClone(brief); emptySummary.role.summary = '';
      assert(validInterviewPreparationBrief(emptySummary, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'an explicitly empty worker summary must remain valid when persisted in the canvas');
      const missingRoleField = structuredClone(brief); delete missingRoleField.role.summary;
      const nullRoleField = structuredClone(brief); nullRoleField.role.location = null;
      assert(!validInterviewPreparationBrief(missingRoleField, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'every public role key must be present');
      assert(!validInterviewPreparationBrief(nullRoleField, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'non-summary public role keys must be safe nonempty strings');
      const bidi = structuredClone(brief); bidi.role.title = 'Café\u202E — Product';
      const c1 = structuredClone(brief); c1.role.summary = 'Owns\u0085 product outcomes.';
      assert(!validInterviewPreparationBrief(bidi, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'bidi controls must not persist in brief display text');
      assert(!validInterviewPreparationBrief(c1, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'C1 controls must not persist in brief display text');
    },
  },
  {
    name: 'interview helper: preparation brief never permits application excerpts in canvas state',
    run: () => {
      const bundleId = 'b'.repeat(64);
      const digest = 'c'.repeat(64);
      const brief = {
        version: 1,
        briefId: 'd'.repeat(64),
        createdAt: '2026-10-08T00:00:00.000Z',
        inputs: { careerSnapshotId: INTERVIEW_SNAPSHOT_ID, jobUrlSha256: 'e'.repeat(64), applicationArtifactId: bundleId, applicationArtifactDigest: digest },
        role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
        roleThemes: [], companyFacts: [{ fact: 'Acme serves teams.', sourceId: 'source-1', sourceUrl: 'https://acme.test/news', sourceDate: '2026-01-01' }], recentContext: [], likelyQuestions: [], questionsToAsk: [],
        applicationPositioning: [{ documentKind: 'resume', point: 'Emphasizes delivery leadership.' }], sources: [], warnings: [],
      };
      assert(validInterviewPreparationBrief(brief, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'compact application positioning should be accepted');
      const excerpt = structuredClone(brief);
      excerpt.applicationPositioning[0].evidenceQuote = 'Candidate led delivery at a private employer.';
      assert(!validInterviewPreparationBrief(excerpt, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'application excerpts must be rejected before canvas persistence');
      const nested = structuredClone(brief);
      nested.inputs.rawListing = 'do not persist';
      assert(!validInterviewPreparationBrief(nested, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'brief inputs must reject nested extras');
      const roleExtra = structuredClone(brief);
      roleExtra.role.rawCompanyResearch = 'do not persist';
      assert(!validInterviewPreparationBrief(roleExtra, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'brief role must reject nested extras');
      const sourceQuote = structuredClone(brief);
      sourceQuote.companyFacts[0].evidenceQuote = 'Acme serves teams.';
      assert(!validInterviewPreparationBrief(sourceQuote, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'research evidence quotes must not be smuggled into canvas state');
      const privateCitation = structuredClone(brief);
      privateCitation.companyFacts[0].sourceUrl = 'https://acme.test/news?access_token=top-secret#candidate@example.test';
      assert(!validInterviewPreparationBrief(privateCitation, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'a restored canvas brief must reject citations that retain query or fragment data');
    },
  },
  {
    name: 'interview helper IPC: accepts only strict snapshot and log-safe node identifiers',
    run: () => {
      assert(isInterviewHelperSnapshotId(INTERVIEW_SNAPSHOT_ID), 'lowercase 64-hex snapshot id should be accepted');
      assert(!isInterviewHelperSnapshotId(INTERVIEW_SNAPSHOT_ID.toUpperCase()), 'uppercase snapshot id must be rejected');
      assert(!isInterviewHelperSnapshotId(` ${INTERVIEW_SNAPSHOT_ID}`), 'snapshot id whitespace must be rejected rather than normalized');
      assert(isInterviewHelperNodeId('interview-helper_01'), 'canvas-safe node id should be accepted');
      assert(!isInterviewHelperNodeId('node\nforged'), 'control characters must not enter IPC task logs');
      assert(!isInterviewHelperNodeId(' node'), 'whitespace node ids must be rejected');
      assert(!isInterviewHelperNodeId('a'.repeat(161)), 'oversized node ids must be rejected');
    },
  },
  {
    name: 'interview helper IPC: projects only allowlisted career facts with opaque direct provenance',
    run: () => {
      const projected = projectInterviewHelperCareerSnapshot(approvedSnapshotFixture());
      const serialized = JSON.stringify(projected);
      assert(projected.snapshotId === INTERVIEW_SNAPSHOT_ID && projected.schemaVersion === 6, 'projection should retain immutable snapshot identity');
      assert(!Object.hasOwn(projected, 'sources') && !Object.hasOwn(projected, 'segments'), 'raw source containers must not cross IPC');
      assert(!Object.hasOwn(projected.profile, 'identity'), 'identity and contacts must not cross IPC');
      assert(!serialized.includes('ada@example.test') && !serialized.includes('RAW_LEGACY_SOURCE_SHOULD_NOT_LEAK') && !serialized.includes('RAW_SEGMENT_SOURCE_SHOULD_NOT_LEAK'), 'contacts and raw source text must not leak through the projection');
      const achievement = projected.profile.achievements[0];
      assert(achievement.roleId === 'role-acme' && achievement.evidenceSegmentIds[0] === 'segment-0003', 'role linkage and opaque achievement provenance must survive');
      assert(achievement.metrics[0].evidenceSegmentIds[0] === 'segment-0003', 'metric provenance must survive');
      const skill = projected.profile.skills.find(item => item.id === 'skill-react');
      assert(skill?.directEvidenceSegmentIds.join(',') === 'segment-0005', 'direct skill provenance must survive while malformed ids are filtered');
      assert(skill?.indexEligible === true, 'the vetted direct skill must retain its controlled index-eligibility boolean');
      assert(!projected.profile.skills.some(item => item.id === 'skill-prototype' || item.id === 'skill-conditional'), 'noneligible and relationship-qualified claims must remain outside the standalone Interview Helper skill projection');
      const other = projected.profile.otherEvidence[0];
      assert(other?.id === 'other-award' && other.text === 'Recognized for delivery.' && other.evidenceSegmentIds[0] === 'segment-0008', 'allowlisted other evidence and opaque provenance must survive');
    },
  },
  {
    name: 'interview helper IPC: projected vetted skills permit only direct exact-usage retrieval',
    run: () => {
      const projected = projectInterviewHelperCareerSnapshot(approvedSnapshotFixture());
      const names = projected.profile.skills.map(skill => skill.name);
      assert(names.includes('React'), 'a current direct/index-eligible skill survives the real IPC projection');
      for (const excluded of ['Prototype', 'Legacy CMS']) {
        assert(!names.includes(excluded), `${excluded} must not cross the projection as a noneligible or relationship-qualified claim`);
      }
    },
  },
  {
    name: 'interview helper IPC: injected loader uses the exact storage root and snapshot id and handles a missing pin',
    run: async () => {
      const snapshot = approvedSnapshotFixture();
      const calls = [];
      const loaded = await loadInterviewHelperCareerSnapshot({
        snapshotId: INTERVIEW_SNAPSHOT_ID,
        userDataPath: '/safe-user-data',
        storageRoot: userDataPath => {
          calls.push(['root', userDataPath]);
          return `${userDataPath}/career-snapshot-store`;
        },
        readSnapshot: async (root, snapshotId) => {
          calls.push(['read', root, snapshotId]);
          return snapshot;
        },
      });
      assert(calls.length === 2 && calls[0].join('|') === 'root|/safe-user-data' && calls[1].join('|') === `read|/safe-user-data/career-snapshot-store|${INTERVIEW_SNAPSHOT_ID}`, 'loader must pass the exact user-data-derived root and snapshot address to the injected reader');
      assert(loaded?.snapshotId === INTERVIEW_SNAPSHOT_ID, 'loader should return the allowlisted snapshot projection');
      const missing = await loadInterviewHelperCareerSnapshot({
        snapshotId: INTERVIEW_SNAPSHOT_ID,
        userDataPath: '/safe-user-data',
        storageRoot: value => value,
        readSnapshot: async () => null,
      });
      assert(missing === null, 'a missing historical pin should be represented as null, not a fabricated profile');
    },
  },
  {
    name: 'interview helper IPC: rejects malformed and unapproved snapshots',
    run: async () => {
      const approved = approvedSnapshotFixture();
      assert(throws(() => projectInterviewHelperCareerSnapshot({ ...approved, status: 'draft' })), 'unapproved snapshots must be rejected before projection');
      assert(throws(() => projectInterviewHelperCareerSnapshot({ ...approved, snapshotId: 'A'.repeat(64) })), 'malformed snapshot addresses must be rejected before projection');
      let malformedRejected = false;
      try {
        await loadInterviewHelperCareerSnapshot({
          snapshotId: INTERVIEW_SNAPSHOT_ID,
          userDataPath: '/safe-user-data',
          storageRoot: value => value,
          readSnapshot: async () => ({ ...approved, status: 'draft' }),
        });
      } catch {
        malformedRejected = true;
      }
      assert(malformedRejected, 'loader must reject an unapproved value returned by its reader');
    },
  },
  {
    name: 'interview helper: a fresh interview starts without a source pin or cue card rail state',
    run: () => {
      const fresh = { data: emptyInterviewData() };
      assert(fresh.data.interviewHelperSourceNodeId === null
        && fresh.data.interviewHelperSourceSnapshotId === null
        && fresh.data.interviewHelperManualAiCleanup === null
        && !('interviewHelperLockedPlan' in fresh.data)
        && !('interviewHelperCurrentStep' in fresh.data),
      'a fresh interview must start without a source pin or the removed cue card rail fields');
    },
  },
  {
    name: 'interview helper IPC: validates node and snapshot ids before task registration or diagnostic logging',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      const calls = [];
      registerInterviewHelperHandlers({
        appInstance: { getPath: name => `/test-${name}` },
        loadSnapshot: async args => {
          calls.push(args);
          return { snapshotId: args.snapshotId, profile: profileFixture() };
        },
      });
      const handler = ipcMain.__getInvokeHandler('load-interview-helper-career-snapshot');
      assert(typeof handler === 'function', 'Interview Helper must register its IPC route through handleSafe');

      const malformedNode = 'forged-node\n[IPC] fake registration';
      const malformedEvent = senderEvent();
      const beforeMalformedLogs = getRecentLogs().length;
      const malformedNodeResult = await handler(malformedEvent, {
        nodeId: malformedNode,
        snapshotId: INTERVIEW_SNAPSHOT_ID,
      });
      const malformedNodeLogs = getRecentLogs().slice(beforeMalformedLogs);
      assert(malformedNodeResult.success === false && /valid node id/iu.test(malformedNodeResult.error),
        `malformed node ids must be rejected at the IPC boundary, got ${JSON.stringify(malformedNodeResult)}`);
      assert(snapshotActiveNodeTasks(malformedEvent.sender.id).length === 0,
        'a malformed node id must never enter the node-task registry');
      assert(!malformedNodeLogs.some(entry => entry.message.includes(malformedNode)),
        'a malformed node id must never be interpolated into diagnostic logging');
      assert(calls.length === 0, 'a malformed node id must not reach the snapshot loader');

      const malformedSnapshotEvent = senderEvent();
      const malformedSnapshotResult = await handler(malformedSnapshotEvent, {
        nodeId: 'interview-helper-1',
        snapshotId: 'not-a-snapshot-id',
      });
      assert(malformedSnapshotResult.success === false && /valid career snapshot id/iu.test(malformedSnapshotResult.error),
        `malformed snapshot ids must be rejected before registration, got ${JSON.stringify(malformedSnapshotResult)}`);
      assert(snapshotActiveNodeTasks(malformedSnapshotEvent.sender.id).length === 0,
        'a malformed snapshot must not register an otherwise valid node id');
      assert(calls.length === 0, 'a malformed snapshot id must not reach the snapshot loader');

      for (const [extraKey, attackerValue] of [
        ['manualAiRunId', 'forged-run\n[IPC] fake task'],
        ['manualAiRecoveryMode', 'forged-recovery\n[IPC] fake context'],
      ]) {
        const extraMetadataEvent = senderEvent();
        const beforeExtraMetadataLogs = getRecentLogs().length;
        const extraMetadataResult = await handler(extraMetadataEvent, {
          nodeId: 'interview-helper-1',
          snapshotId: INTERVIEW_SNAPSHOT_ID,
          [extraKey]: attackerValue,
        });
        const extraMetadataLogs = getRecentLogs().slice(beforeExtraMetadataLogs);
        assert(extraMetadataResult.success === false && /only nodeId and snapshotId/iu.test(extraMetadataResult.error),
          `${extraKey} must be rejected before generic task metadata is read, got ${JSON.stringify(extraMetadataResult)}`);
        assert(snapshotActiveNodeTasks(extraMetadataEvent.sender.id).length === 0,
          `${extraKey} must not register a node task`);
        assert(!extraMetadataLogs.some(entry => entry.message.includes(attackerValue)),
          `${extraKey} must not be interpolated into diagnostic logging`);
        assert(calls.length === 0, `${extraKey} must not reach the snapshot loader`);
      }

      const inheritedAttackerValue = 'inherited-run\n[IPC] fake inherited task';
      const inheritedMetadataArgs = Object.assign(Object.create({ manualAiRunId: inheritedAttackerValue }), {
        nodeId: 'interview-helper-1',
        snapshotId: INTERVIEW_SNAPSHOT_ID,
      });
      const inheritedMetadataEvent = senderEvent();
      const beforeInheritedMetadataLogs = getRecentLogs().length;
      const inheritedMetadataResult = await handler(inheritedMetadataEvent, inheritedMetadataArgs);
      const inheritedMetadataLogs = getRecentLogs().slice(beforeInheritedMetadataLogs);
      assert(inheritedMetadataResult.success === false && /only nodeId and snapshotId/iu.test(inheritedMetadataResult.error),
        `inherited generic metadata must be rejected before task setup, got ${JSON.stringify(inheritedMetadataResult)}`);
      assert(snapshotActiveNodeTasks(inheritedMetadataEvent.sender.id).length === 0 && calls.length === 0,
        'inherited generic metadata must not register a node or reach the snapshot loader');
      assert(!inheritedMetadataLogs.some(entry => entry.message.includes(inheritedAttackerValue)),
        'inherited generic metadata must not reach diagnostic logging');

      const validEvent = senderEvent();
      const validResult = await handler(validEvent, {
        nodeId: 'interview-helper-1',
        snapshotId: INTERVIEW_SNAPSHOT_ID,
      });
      assert(validResult.success === true && validResult.snapshot?.snapshotId === INTERVIEW_SNAPSHOT_ID,
        `valid Interview Helper requests must still succeed, got ${JSON.stringify(validResult)}`);
      assert(calls.length === 1 && calls[0].snapshotId === INTERVIEW_SNAPSHOT_ID && calls[0].userDataPath === '/test-userData',
        'only the valid request should reach the injected loader with the app-owned user-data path');
      assert(snapshotActiveNodeTasks(validEvent.sender.id).length === 0,
        'a completed valid request must still clean up its task registry entry');
    },
  },
  {
    name: 'interview helper: Google Jobs document ids keep their base64 padding and nothing else',
    run: async () => {
      const { normalizeInterviewPreparationJobUrl } = await import('../../electron/ipc/interviewPreparation.js');
      const padded = 'https://www.google.com/search?q=ada%40example.test&udm=8&htidocid=ZMarQLnfvtRm5rkhAAAAAA%3D%3D&hl=en&token=secret';
      const expected = 'https://www.google.com/search?udm=8&htidocid=ZMarQLnfvtRm5rkhAAAAAA%3D%3D&hl=en';
      assert(canonicalInterviewJobUrl(padded) === expected && normalizeInterviewPreparationJobUrl(padded) === expected,
        `a real padded Google Jobs id must survive canonicalization, got ${canonicalInterviewJobUrl(padded)}`);
      for (const bad of ['abc%3Ddef', 'abc%3D%3D%3D', '%3D%3D']) {
        const url = `https://www.google.com/search?udm=8&htidocid=${bad}`;
        assert(canonicalInterviewJobUrl(url) === 'https://www.google.com/search?udm=8', `'=' outside trailing padding must drop the id: ${bad}`);
      }
    },
  },
];
