/**
 * Data pools of the demo seed: a fictitious European company ("Kestrel"), its departments,
 * offices and name pools. Departments, job titles and the European offices come from the
 * test user generator; every address is under a reserved domain (RFC 2606).
 */
import { DEPARTMENTS, JOB_TITLES_BY_DEPT, LOCATIONS } from '../generate-test-users';

/** Work addresses of the people of the main HR source. */
export const DEMO_EMAIL_DOMAIN = 'demo.example.com';
/** Work addresses of the subsidiary whose HR runs on the JSON API source. */
export const SUBSIDIARY_EMAIL_DOMAIN = 'iberia.demo.example.com';

/** The HR sources (connector ids, as an HR sync names them on identity sources). */
export const PRIMARY_HR = 'csv-hr';
export const SECONDARY_HR = 'json-api-hr';

/** Target systems as onboarding names them on provisioning entries. */
export type TargetSystem = 'entra' | 'ad' | 'okta' | 'github' | 'file-outbound';

export interface DepartmentPool {
  code: string;
  name: string;
  division: string;
  /** Share of the head count (relative). */
  weight: number;
  headTitle: string;
  leadTitle: string;
  titles: string[];
  /** Targets beyond Entra ID, AD and the payroll file every employee gets. */
  extraTargets: TargetSystem[];
}

const HEAD_TITLES: Record<string, [string, string]> = {
  Engineering: ['Chief Technology Officer', 'Engineering Team Lead'],
  Sales: ['VP Sales', 'Sales Team Lead'],
  Marketing: ['VP Marketing', 'Marketing Team Lead'],
  'Human Resources': ['Chief People Officer', 'HR Team Lead'],
  Finance: ['Chief Financial Officer', 'Finance Team Lead'],
  Legal: ['General Counsel', 'Legal Team Lead'],
  Product: ['VP Product', 'Product Team Lead'],
  Support: ['Head of Customer Support', 'Support Team Lead'],
  Operations: ['Chief Operating Officer', 'Operations Team Lead'],
};

const WEIGHTS: Record<string, number> = {
  Engineering: 28,
  Sales: 14,
  Support: 12,
  Product: 11,
  Marketing: 8,
  Operations: 8,
  Finance: 7,
  'Human Resources': 6,
  Legal: 4,
};

const EXTRA_TARGETS: Record<string, TargetSystem[]> = {
  Engineering: ['github'],
  Product: ['github', 'okta'],
  Sales: ['okta'],
  Marketing: ['okta'],
  Support: ['okta'],
};

/** The generator's departments; Design is folded into Product, so there are nine plus the CEO's. */
export const DEPARTMENT_POOLS: DepartmentPool[] = DEPARTMENTS.filter(
  (d) => d.name !== 'Design',
).map((d) => ({
  ...d,
  weight: WEIGHTS[d.name],
  headTitle: HEAD_TITLES[d.name][0],
  leadTitle: HEAD_TITLES[d.name][1],
  titles: [
    ...(JOB_TITLES_BY_DEPT[d.name] ?? []),
    ...(d.name === 'Product' ? (JOB_TITLES_BY_DEPT['Design'] ?? []) : []),
  ].filter((t) => t !== 'Tech Lead'),
  extraTargets: EXTRA_TARGETS[d.name] ?? [],
}));

export const EXECUTIVE_POOL: DepartmentPool = {
  code: 'EXEC-001',
  name: 'Executive Office',
  division: 'Executive',
  weight: 0,
  headTitle: 'Chief Executive Officer',
  leadTitle: 'Chief Executive Officer',
  titles: ['Executive Assistant'],
  extraTargets: ['okta'],
};

export interface OfficePool {
  code: string;
  office: string;
  city: string;
  state: string;
  country: string;
  tz: string;
  postal: string;
  weight: number;
  /** Name pool most people of the office come from. */
  names: string;
}

const OFFICE_EXTRAS: Array<Omit<OfficePool, 'weight' | 'names'>> = [
  {
    code: 'FR-PAR',
    office: 'Paris Office',
    city: 'Paris',
    state: 'Ile-de-France',
    country: 'FR',
    tz: 'Europe/Paris',
    postal: '75002',
  },
  {
    code: 'ES-MAD',
    office: 'Madrid Office',
    city: 'Madrid',
    state: 'Madrid',
    country: 'ES',
    tz: 'Europe/Madrid',
    postal: '28013',
  },
  {
    code: 'NL-AMS',
    office: 'Amsterdam Office',
    city: 'Amsterdam',
    state: 'Noord-Holland',
    country: 'NL',
    tz: 'Europe/Amsterdam',
    postal: '1012 AB',
  },
  {
    code: 'PL-WAW',
    office: 'Warsaw Office',
    city: 'Warsaw',
    state: 'Mazowieckie',
    country: 'PL',
    tz: 'Europe/Warsaw',
    postal: '00-001',
  },
];

const OFFICE_WEIGHTS: Record<string, [number, string]> = {
  'FI-HEL': [30, 'fi'],
  'SE-STO': [14, 'se'],
  'DE-BER': [14, 'de'],
  'FR-PAR': [10, 'fr'],
  'ES-MAD': [10, 'es'],
  'NL-AMS': [8, 'nl'],
  'PL-WAW': [8, 'pl'],
  'UK-LON': [6, 'gb'],
};

/** The generator's European offices (Helsinki is the head office) plus four more. */
export const OFFICE_POOLS: OfficePool[] = [...LOCATIONS, ...OFFICE_EXTRAS]
  .filter((l) => OFFICE_WEIGHTS[l.code])
  .map((l) => ({ ...l, weight: OFFICE_WEIGHTS[l.code][0], names: OFFICE_WEIGHTS[l.code][1] }));

/** Common given names and surnames per country (comma separated); random pairs, no real people. */
const NAMES: Record<string, { first: string; last: string }> = {
  fi: {
    first:
      'Aino,Eero,Helmi,Juho,Kaisa,Lauri,Minna,Otto,Riikka,Sami,Tiina,Ville,Elina,Antti,Noora,Matti',
    last: 'Virtanen,Korhonen,Mäkinen,Nieminen,Hämäläinen,Laine,Heikkinen,Koskinen,Järvinen,Lehtonen,Salminen,Lahtinen,Rantanen,Tuominen,Kallio,Saarinen',
  },
  se: {
    first:
      'Astrid,Björn,Elsa,Gustav,Ingrid,Johan,Karin,Lars,Maja,Nils,Sofia,Oskar,Linnea,Henrik,Ebba,Viktor',
    last: 'Andersson,Johansson,Karlsson,Nilsson,Eriksson,Larsson,Olsson,Persson,Svensson,Gustafsson,Lindberg,Bergström,Lindqvist,Holm,Sandberg,Ekström',
  },
  de: {
    first:
      'Anna,Felix,Hannah,Jonas,Lea,Lukas,Marie,Maximilian,Clara,Paul,Sophie,Tobias,Katrin,Florian,Greta,Stefan',
    last: 'Müller,Schmidt,Schneider,Fischer,Weber,Meyer,Wagner,Becker,Schulz,Hoffmann,Koch,Richter,Wolf,Neumann,Krüger,Braun',
  },
  fr: {
    first:
      'Camille,Lucas,Chloé,Hugo,Léa,Louis,Manon,Théo,Inès,Julien,Margaux,Antoine,Élodie,Mathieu,Juliette,Nicolas',
    last: 'Martin,Bernard,Dubois,Thomas,Robert,Richard,Petit,Durand,Leroy,Moreau,Simon,Laurent,Lefèvre,Michel,Fontaine,Girard',
  },
  es: {
    first:
      'Lucía,Alejandro,Carmen,Javier,Elena,Pablo,Marta,Diego,Sara,Álvaro,Paula,Sergio,Nuria,Raúl,Irene,Andrés',
    last: 'García,Fernández,González,Rodríguez,López,Martínez,Sánchez,Pérez,Gómez,Ruiz,Díaz,Moreno,Muñoz,Álvarez,Romero,Navarro',
  },
  nl: {
    first:
      'Daan,Emma,Sem,Julia,Bram,Sanne,Thijs,Fleur,Ruben,Lotte,Jesse,Femke,Koen,Iris,Milan,Anouk',
    last: 'de Jong,Jansen,de Vries,van den Berg,van Dijk,Bakker,Janssen,Visser,Smit,Meijer,de Boer,Mulder,de Groot,Bos,Vos,Peters',
  },
  pl: {
    first:
      'Agnieszka,Piotr,Katarzyna,Tomasz,Magdalena,Paweł,Joanna,Michał,Zofia,Krzysztof,Aleksandra,Marcin,Ewa,Łukasz,Natalia,Jakub',
    last: 'Nowak,Kowalski,Wiśniewski,Wójcik,Kowalczyk,Kamiński,Lewandowski,Zieliński,Szymański,Woźniak,Dąbrowski,Kozłowski,Jankowski,Mazur,Krawczyk,Piotrowski',
  },
  gb: {
    first:
      'Oliver,Amelia,Harry,Isla,George,Emily,James,Grace,William,Lucy,Thomas,Ella,Charlie,Freya,Jack,Alice',
    last: 'Smith,Jones,Taylor,Brown,Williams,Wilson,Evans,Walker,Wright,Robinson,Thompson,Hughes,Clarke,Hall,Green,Wood',
  },
  it: {
    first: 'Giulia,Marco,Francesca,Luca,Chiara,Matteo,Sara,Alessandro,Valentina,Davide',
    last: 'Rossi,Russo,Ferrari,Esposito,Bianchi,Romano,Colombo,Ricci,Marino,Greco',
  },
  pt: {
    first: 'Beatriz,João,Mariana,Tiago,Inês,Rui,Catarina,Miguel,Rita,Duarte',
    last: 'Silva,Santos,Ferreira,Pereira,Oliveira,Costa,Rodrigues,Martins,Sousa,Carvalho',
  },
};

export const NAME_POOLS: Record<string, { first: string[]; last: string[] }> = Object.fromEntries(
  Object.entries(NAMES).map(([key, pool]) => [
    key,
    { first: pool.first.split(','), last: pool.last.split(',') },
  ]),
);

/** Name pools people of any office may come from (a mobile European workforce). */
export const MOBILE_NAME_POOLS = ['it', 'pt', 'de', 'fr', 'es', 'se', 'pl', 'nl'];

/** An address local part: lower case ASCII, letters only between the dots. */
export function asciiName(name: string): string {
  return name
    .replace(/ß/g, 'ss')
    .replace(/[łŁ]/g, 'l')
    .replace(/[øØ]/g, 'o')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}
