/* The fictional organization the simulator runs against: Northwind Health Data Platform.
 * People, datasets, services and known issues are all made up. The mock tools read from here.
 */
(function (AT) {
  'use strict';

  AT.data = {
    org: 'Northwind Health Data Platform',

    // The directory. Role, training, projects and agreements are the attributes policy reads.
    people: {
      'priya.raman': {
        name: 'Priya Raman', role: 'analyst', team: 'Population Health', status: 'active', manager: 'lena.ortiz',
        training: ['hipaa_basics', 'data_handling_101'], projects: [], agreements: [],
      },
      'marcus.lee': {
        name: 'Marcus Lee', role: 'data_scientist', team: 'Clinical Research', status: 'active', manager: 'lena.ortiz',
        training: ['hipaa_basics', 'data_handling_101', 'human_subjects'], projects: ['IRB-2291'], agreements: ['DUA-114'],
      },
      'theo.nguyen': {
        name: 'Theo Nguyen', role: 'data_engineer', team: 'Platform Engineering', status: 'active', manager: 'lena.ortiz',
        training: ['hipaa_basics', 'data_handling_101'], projects: [], agreements: [],
      },
      'dana.whitfield': {
        name: 'Dana Whitfield', role: 'contractor', team: 'Finance Analytics', status: 'active', manager: 'lena.ortiz',
        training: ['hipaa_basics'], projects: [], agreements: [],
      },
      'lena.ortiz': {
        name: 'Lena Ortiz', role: 'manager', team: 'Population Health', status: 'active', manager: null,
        training: ['hipaa_basics', 'data_handling_101'], projects: [], agreements: [],
      },
      'sam.rivera': {
        name: 'Sam Rivera', role: 'analyst', team: 'Population Health', status: 'pending_start', manager: 'lena.ortiz',
        startDate: '2026-10-19', training: [], projects: [], agreements: [],
      },
    },

    // The data catalog. Classification drives the policy rules; aliases let the router and
    // lookup_dataset match how people actually ask for things.
    datasets: {
      claims_deid_monthly: {
        name: 'Claims, de-identified (monthly)', classification: 'deidentified', steward: 'Payer Analytics',
        roles: ['analyst', 'data_scientist', 'data_engineer', 'manager'], training: ['hipaa_basics'],
        aliases: ['claims', 'claims data', 'claims table', 'de-identified claims', 'deid claims'],
      },
      pharmacy_fills_deid: {
        name: 'Pharmacy fills, de-identified', classification: 'deidentified', steward: 'Pharmacy Analytics',
        roles: ['analyst', 'data_scientist', 'data_engineer', 'manager'], training: ['hipaa_basics'],
        aliases: ['pharmacy', 'pharmacy fills', 'rx fills', 'prescriptions'],
      },
      encounters_limited: {
        name: 'Encounters, limited data set', classification: 'limited', steward: 'Clinical Data Office',
        roles: ['data_scientist'], training: ['hipaa_basics', 'human_subjects'], requires: { agreement: true },
        aliases: ['encounters', 'encounter data', 'visit data'],
      },
      patient_identified_ehr: {
        name: 'EHR extract, identified', classification: 'identified', steward: 'Clinical Data Office',
        roles: ['data_scientist'], training: ['hipaa_basics', 'human_subjects'], requires: { project: true },
        aliases: ['identified ehr', 'ehr extract', 'identified patient', 'patient-level ehr'],
      },
      behavioral_health_notes: {
        name: 'Behavioral health clinical notes', classification: 'restricted', steward: 'Data Governance Board',
        roles: [], training: [],
        aliases: ['behavioral health notes', 'therapy notes', 'psychotherapy notes', 'behavioral health'],
      },
      provider_directory: {
        name: 'Provider directory', classification: 'internal', steward: 'Network Management',
        roles: '*', training: [],
        aliases: ['provider directory', 'providers list'],
      },
    },

    // Grants that already exist, so check_existing_access has something to find.
    grants: {
      'theo.nguyen': ['claims_deid_monthly', 'provider_directory'],
      'priya.raman': ['provider_directory'],
      'marcus.lee': ['claims_deid_monthly', 'encounters_limited'],
    },

    // What a new starter gets by default. Only de-identified or internal data: least privilege.
    roleTemplates: {
      analyst: { workspace: 'analytics-standard', datasets: ['claims_deid_monthly', 'provider_directory'], training: ['hipaa_basics', 'data_handling_101'] },
      data_scientist: { workspace: 'ds-gpu-small', datasets: ['claims_deid_monthly'], training: ['hipaa_basics', 'data_handling_101', 'human_subjects'] },
      data_engineer: { workspace: 'eng-standard', datasets: ['provider_directory'], training: ['hipaa_basics', 'data_handling_101'] },
    },

    services: {
      warehouse: { name: 'Analytics warehouse', status: 'operational', aliases: ['warehouse', 'query', 'queries', 'sql'] },
      bi_dashboards: { name: 'BI dashboards', status: 'degraded', note: 'Scheduled refreshes failing for some workspaces', aliases: ['dashboard', 'dashboards', 'report', 'refresh'] },
      lab_feed: { name: 'Lab results ingestion', status: 'degraded', note: 'Feed running about 3 hours behind', aliases: ['lab results', 'lab feed', 'labs', 'lab data'] },
      notebooks: { name: 'Notebook service', status: 'operational', aliases: ['notebook', 'notebooks', 'jupyter', 'kernel'] },
      catalog: { name: 'Data catalog', status: 'operational', aliases: ['catalog'] },
    },

    knownIssues: [
      {
        id: 'KI-1042', service: 'bi_dashboards',
        title: 'Scheduled dashboard refresh fails after credential rotation',
        keywords: ['refresh', 'stale', 'dashboard', 'credentials', 'expired', 'updating', 'old'],
        fix: 'Re-authorize the data source under Workspace settings → Connections. The next refresh picks it up.',
        url: 'https://kb.northwind.example/KI-1042',
      },
      {
        id: 'KI-0987', service: 'warehouse',
        title: 'Long-running queries cancelled at the 30-minute default timeout',
        keywords: ['query', 'cancelled', 'canceled', 'timeout', '30', 'minutes', 'long'],
        fix: 'Use the large-query warehouse (`wh_large`), which allows 2 hours, or split the query by month.',
        url: 'https://kb.northwind.example/KI-0987',
      },
      {
        id: 'KI-1011', service: 'notebooks',
        title: 'Notebook kernel restarts when loading more than 8 GB',
        keywords: ['kernel', 'restart', 'died', 'memory', 'notebook', 'crash'],
        fix: 'Switch the notebook to the 32 GB profile, or read the table in chunks.',
        url: 'https://kb.northwind.example/KI-1011',
      },
    ],

    onCall: {
      lab_feed: 'Ingestion on-call',
      bi_dashboards: 'BI platform on-call',
      warehouse: 'Warehouse on-call',
      notebooks: 'Notebook platform on-call',
      default: 'Data platform service desk',
    },
  };

  // Give each record its own id, so a person or dataset can be passed around on its own.
  for (const [id, p] of Object.entries(AT.data.people)) p.id = id;
  for (const [id, d] of Object.entries(AT.data.datasets)) d.id = id;
  for (const [id, s] of Object.entries(AT.data.services)) s.id = id;
})(globalThis.AT = globalThis.AT || {});
