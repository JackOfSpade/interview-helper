// Pure location helpers. Kept dependency-free (no electron / puppeteer) so
// they're unit-testable in isolation and shared by the main process.
//
// `normalizeLocationInput` turns a free-text or structured location into a
// consistent shape (city / subdivision / country / board-ready string);
// `normalizeCountry` canonicalises a country name.

// Canonical, board-friendly country names. The query-gen model infers a country
// as FREE TEXT — "US" / "USA" / "U.S." / "America" / "United States of America"
// all mean one place — but a board's location FILTER needs ONE consistent string.
// Map common variants + unambiguous ISO codes to a canonical full name; anything
// unrecognized passes through (already a plain country name the model produced,
// which boards tolerate). Mirrors the US_STATES code↔name normalization below.
// Ambiguous 2-letter codes that collide with US state codes (ca=California,
// in=Indiana, de=Delaware, or=Oregon…) are intentionally OMITTED — the schema
// asks the model for full names, so those would be mis-maps far more often than hits.
const COUNTRY_ALIASES = {
  'us': 'United States', 'usa': 'United States', 'america': 'United States',
  'united states of america': 'United States', 'united states': 'United States',
  'uk': 'United Kingdom', 'gb': 'United Kingdom', 'great britain': 'United Kingdom',
  'britain': 'United Kingdom', 'england': 'United Kingdom', 'united kingdom': 'United Kingdom',
  'can': 'Canada', 'canada': 'Canada',
  'aus': 'Australia', 'australia': 'Australia',
  'nz': 'New Zealand', 'new zealand': 'New Zealand',
  'ireland': 'Ireland', 'germany': 'Germany', 'deutschland': 'Germany',
  'france': 'France', 'india': 'India', 'singapore': 'Singapore',

  // ── Extended country coverage ────────────────────────────────────────────
  // Every UN member state, plus the commonly listed territories Hong Kong,
  // Taiwan and Puerto Rico, so a country the query model spells any reasonable
  // way reaches a board's location filter as ONE canonical English name. This
  // table ALSO drives search-location parsing, where a country match outranks a
  // subdivision match, so the omissions are deliberate:
  //   * 'georgia' is never a country key — it must keep meaning the US state.
  //     The country is reachable only as 'georgia (country)' / 'sakartvelo'.
  //   * No ISO 3166-1 alpha-2 code that is a US state or Canadian province code
  //     (ca,in,de,al,ar,co,ga,id,il,la,ma,md,me,mn,mo,mt,nc,nd,ne,pa,sc,sd,va,
  //     ak,az,ct,fl,hi,ia,ks,ky,mi,ms,nv,nh,nj,nm,ny,oh,ok,or,ri,tn,tx,ut,vt,
  //     wa,wv,wi,wy,dc,as,gu,mp,pr,vi,ab,bc,mb,nb,nl,ns,nt,nu,on,pe,qc,sk,yt):
  //     'nl' stays Newfoundland and Labrador, 'pe' Prince Edward Island, and
  //     'pr' stays the Puerto Rico US-territory subdivision so "San Juan, PR"
  //     keeps resolving to the United States.
  //   * No alpha-2 code that is an English word or everyday abbreviation
  //     (to,is,it,no,me,am,be,by,do,so,as,at,ad,an,or,my,id,in,la…). Only
  //     unmistakable codes are kept ('fi','au','cn','jp','dk','hk'); the bare
  //     name is always available. Preferring an omission over a mis-map.
  'afghanistan': 'Afghanistan', 'afg': 'Afghanistan',
  'albania': 'Albania',
  'algeria': 'Algeria', 'dza': 'Algeria',
  'andorra': 'Andorra',
  'angola': 'Angola', 'ago': 'Angola',
  'antigua and barbuda': 'Antigua and Barbuda', 'antigua': 'Antigua and Barbuda', 'atg': 'Antigua and Barbuda',
  'argentina': 'Argentina', 'arg': 'Argentina',
  'armenia': 'Armenia',
  'au': 'Australia', 'austria': 'Austria', 'aut': 'Austria',
  'azerbaijan': 'Azerbaijan', 'aze': 'Azerbaijan',
  'bahamas': 'Bahamas', 'the bahamas': 'Bahamas', 'bhs': 'Bahamas',
  'bahrain': 'Bahrain', 'bhr': 'Bahrain',
  'bangladesh': 'Bangladesh', 'bgd': 'Bangladesh',
  'barbados': 'Barbados', 'brb': 'Barbados',
  'belarus': 'Belarus', 'blr': 'Belarus',
  'belgium': 'Belgium', 'bel': 'Belgium',
  'belize': 'Belize', 'blz': 'Belize',
  'benin': 'Benin',
  'bhutan': 'Bhutan', 'btn': 'Bhutan',
  'bolivia': 'Bolivia', 'bol': 'Bolivia',
  'bosnia and herzegovina': 'Bosnia and Herzegovina', 'bosnia': 'Bosnia and Herzegovina', 'bih': 'Bosnia and Herzegovina',
  'botswana': 'Botswana', 'bwa': 'Botswana',
  'brazil': 'Brazil',
  'brunei': 'Brunei', 'brunei darussalam': 'Brunei', 'brn': 'Brunei',
  'bulgaria': 'Bulgaria', 'bgr': 'Bulgaria',
  'burkina faso': 'Burkina Faso', 'burkina': 'Burkina Faso', 'bfa': 'Burkina Faso',
  'burundi': 'Burundi', 'bdi': 'Burundi',
  'cabo verde': 'Cabo Verde', 'cape verde': 'Cabo Verde', 'cpv': 'Cabo Verde',
  'cambodia': 'Cambodia', 'khm': 'Cambodia',
  'cameroon': 'Cameroon', 'cmr': 'Cameroon',
  'central african republic': 'Central African Republic', 'caf': 'Central African Republic',
  'chad': 'Chad', 'tcd': 'Chad',
  'chile': 'Chile', 'chl': 'Chile',
  'china': 'China', 'cn': 'China', 'chn': 'China',
  'colombia': 'Colombia',
  'comoros': 'Comoros',
  'congo': 'Congo', 'republic of the congo': 'Congo', 'congo brazzaville': 'Congo',
  'democratic republic of the congo': 'Democratic Republic of the Congo',
  'dr congo': 'Democratic Republic of the Congo', 'drc': 'Democratic Republic of the Congo',
  'costa rica': 'Costa Rica', 'cri': 'Costa Rica',
  "cote d'ivoire": 'Ivory Coast', 'cote d ivoire': 'Ivory Coast',
  "côte d'ivoire": 'Ivory Coast', 'ivory coast': 'Ivory Coast', 'civ': 'Ivory Coast',
  'croatia': 'Croatia', 'hrv': 'Croatia',
  'cuba': 'Cuba',
  'cyprus': 'Cyprus', 'cyp': 'Cyprus',
  'czechia': 'Czechia', 'czech republic': 'Czechia', 'cze': 'Czechia',
  'denmark': 'Denmark', 'dk': 'Denmark', 'dnk': 'Denmark',
  'djibouti': 'Djibouti', 'dji': 'Djibouti',
  'dominica': 'Dominica',
  'dominican republic': 'Dominican Republic',
  'ecuador': 'Ecuador', 'ecu': 'Ecuador',
  'egypt': 'Egypt', 'egy': 'Egypt',
  'el salvador': 'El Salvador', 'slv': 'El Salvador',
  'equatorial guinea': 'Equatorial Guinea', 'gnq': 'Equatorial Guinea',
  'eritrea': 'Eritrea', 'eri': 'Eritrea',
  'estonia': 'Estonia',
  'eswatini': 'Eswatini', 'swaziland': 'Eswatini', 'swz': 'Eswatini',
  'ethiopia': 'Ethiopia',
  'fiji': 'Fiji', 'fji': 'Fiji',
  'finland': 'Finland', 'fin': 'Finland', 'fi': 'Finland',
  'gabon': 'Gabon',
  'gambia': 'Gambia', 'the gambia': 'Gambia', 'gmb': 'Gambia',
  'georgia (country)': 'Georgia', 'georgia country': 'Georgia', 'sakartvelo': 'Georgia',
  'ghana': 'Ghana', 'gha': 'Ghana',
  'greece': 'Greece', 'grc': 'Greece',
  'grenada': 'Grenada', 'grd': 'Grenada',
  'guatemala': 'Guatemala', 'gtm': 'Guatemala',
  'guinea': 'Guinea', 'gin': 'Guinea',
  'guinea-bissau': 'Guinea-Bissau', 'guinea bissau': 'Guinea-Bissau', 'gnb': 'Guinea-Bissau',
  'guyana': 'Guyana',
  'haiti': 'Haiti', 'hti': 'Haiti',
  'honduras': 'Honduras', 'hnd': 'Honduras',
  'hong kong': 'Hong Kong', 'hk': 'Hong Kong', 'hkg': 'Hong Kong',
  'hungary': 'Hungary',
  'iceland': 'Iceland',
  'indonesia': 'Indonesia', 'idn': 'Indonesia',
  'iran': 'Iran', 'islamic republic of iran': 'Iran', 'irn': 'Iran',
  'iraq': 'Iraq', 'irq': 'Iraq',
  'israel': 'Israel', 'isr': 'Israel',
  'italy': 'Italy', 'ita': 'Italy',
  'jamaica': 'Jamaica',
  'japan': 'Japan', 'jp': 'Japan', 'jpn': 'Japan',
  'jordan': 'Jordan',
  'kazakhstan': 'Kazakhstan', 'kaz': 'Kazakhstan',
  'kenya': 'Kenya',
  'kiribati': 'Kiribati',
  'kuwait': 'Kuwait', 'kwt': 'Kuwait',
  'kyrgyzstan': 'Kyrgyzstan', 'kgz': 'Kyrgyzstan',
  'laos': 'Laos',
  'latvia': 'Latvia', 'lva': 'Latvia',
  'lebanon': 'Lebanon', 'lbn': 'Lebanon',
  'lesotho': 'Lesotho', 'lso': 'Lesotho',
  'liberia': 'Liberia', 'lbr': 'Liberia',
  'libya': 'Libya', 'lby': 'Libya',
  'liechtenstein': 'Liechtenstein',
  'lithuania': 'Lithuania', 'ltu': 'Lithuania',
  'luxembourg': 'Luxembourg',
  'madagascar': 'Madagascar', 'mdg': 'Madagascar',
  'malawi': 'Malawi', 'mwi': 'Malawi',
  'malaysia': 'Malaysia',
  'maldives': 'Maldives', 'mdv': 'Maldives',
  'mali': 'Mali',
  'malta': 'Malta',
  'marshall islands': 'Marshall Islands', 'mhl': 'Marshall Islands',
  'mauritania': 'Mauritania', 'mrt': 'Mauritania',
  'mauritius': 'Mauritius',
  'mexico': 'Mexico',
  'micronesia': 'Micronesia', 'fsm': 'Micronesia',
  'moldova': 'Moldova', 'mda': 'Moldova',
  'monaco': 'Monaco',
  'mongolia': 'Mongolia',
  'montenegro': 'Montenegro',
  'morocco': 'Morocco',
  'mozambique': 'Mozambique',
  'myanmar': 'Myanmar', 'burma': 'Myanmar', 'mmr': 'Myanmar',
  'namibia': 'Namibia',
  'nauru': 'Nauru',
  'nepal': 'Nepal',
  'netherlands': 'Netherlands', 'the netherlands': 'Netherlands',
  'holland': 'Netherlands', 'nld': 'Netherlands',
  'nicaragua': 'Nicaragua',
  'niger': 'Niger',
  'nigeria': 'Nigeria', 'nga': 'Nigeria',
  'north korea': 'North Korea', 'dprk': 'North Korea', 'prk': 'North Korea',
  'north macedonia': 'North Macedonia', 'macedonia': 'North Macedonia', 'mkd': 'North Macedonia',
  'norway': 'Norway',
  'oman': 'Oman',
  'pakistan': 'Pakistan', 'pak': 'Pakistan',
  'palau': 'Palau',
  'panama': 'Panama',
  'papua new guinea': 'Papua New Guinea',
  'paraguay': 'Paraguay', 'pry': 'Paraguay',
  'peru': 'Peru',
  'philippines': 'Philippines', 'the philippines': 'Philippines', 'phl': 'Philippines',
  'poland': 'Poland',
  'portugal': 'Portugal', 'prt': 'Portugal',
  // Puerto Rico is deliberately absent: it is a US territory subdivision (see
  // US_STATES), so "San Juan, Puerto Rico" stays inside United States scope.
  'qatar': 'Qatar', 'qat': 'Qatar',
  'romania': 'Romania', 'rou': 'Romania',
  'russia': 'Russia', 'russian federation': 'Russia', 'rus': 'Russia',
  'rwanda': 'Rwanda', 'rwa': 'Rwanda',
  'saint kitts and nevis': 'Saint Kitts and Nevis', 'st kitts and nevis': 'Saint Kitts and Nevis', 'kna': 'Saint Kitts and Nevis',
  'saint lucia': 'Saint Lucia', 'st lucia': 'Saint Lucia', 'lca': 'Saint Lucia',
  'saint vincent and the grenadines': 'Saint Vincent and the Grenadines',
  'st vincent and the grenadines': 'Saint Vincent and the Grenadines', 'vct': 'Saint Vincent and the Grenadines',
  'samoa': 'Samoa',
  'san marino': 'San Marino', 'smr': 'San Marino',
  'sao tome and principe': 'Sao Tome and Principe', 'sao tome': 'Sao Tome and Principe', 'stp': 'Sao Tome and Principe',
  'saudi arabia': 'Saudi Arabia', 'ksa': 'Saudi Arabia',
  'scotland': 'United Kingdom', 'wales': 'United Kingdom',
  'senegal': 'Senegal',
  'serbia': 'Serbia', 'srb': 'Serbia',
  'seychelles': 'Seychelles',
  'sierra leone': 'Sierra Leone',
  'slovakia': 'Slovakia', 'svk': 'Slovakia',
  'slovenia': 'Slovenia', 'svn': 'Slovenia',
  'solomon islands': 'Solomon Islands',
  'somalia': 'Somalia',
  'south africa': 'South Africa', 'rsa': 'South Africa', 'zaf': 'South Africa',
  'south korea': 'South Korea', 'korea': 'South Korea',
  'republic of korea': 'South Korea', 'kor': 'South Korea',
  'south sudan': 'South Sudan', 'ssd': 'South Sudan',
  'spain': 'Spain', 'esp': 'Spain',
  'sri lanka': 'Sri Lanka', 'lka': 'Sri Lanka',
  'sudan': 'Sudan', 'sdn': 'Sudan',
  'suriname': 'Suriname',
  'sweden': 'Sweden',
  'switzerland': 'Switzerland', 'swiss': 'Switzerland', 'che': 'Switzerland',
  'syria': 'Syria',
  'taiwan': 'Taiwan', 'twn': 'Taiwan',
  'tajikistan': 'Tajikistan', 'tjk': 'Tajikistan',
  'tanzania': 'Tanzania', 'tza': 'Tanzania',
  'thailand': 'Thailand',
  'timor-leste': 'Timor-Leste', 'east timor': 'Timor-Leste', 'tls': 'Timor-Leste',
  'togo': 'Togo',
  'tonga': 'Tonga',
  'trinidad and tobago': 'Trinidad and Tobago', 'trinidad': 'Trinidad and Tobago', 'tto': 'Trinidad and Tobago',
  'tunisia': 'Tunisia',
  'turkey': 'Turkey', 'turkiye': 'Turkey',
  'turkmenistan': 'Turkmenistan', 'tkm': 'Turkmenistan',
  'tuvalu': 'Tuvalu',
  'uganda': 'Uganda', 'uga': 'Uganda',
  'ukraine': 'Ukraine', 'ukr': 'Ukraine',
  'united arab emirates': 'United Arab Emirates', 'uae': 'United Arab Emirates',
  'uruguay': 'Uruguay', 'ury': 'Uruguay',
  'uzbekistan': 'Uzbekistan', 'uzb': 'Uzbekistan',
  'vanuatu': 'Vanuatu',
  'venezuela': 'Venezuela',
  'vietnam': 'Vietnam', 'viet nam': 'Vietnam', 'vnm': 'Vietnam',
  'yemen': 'Yemen',
  'zambia': 'Zambia', 'zmb': 'Zambia',
  'zimbabwe': 'Zimbabwe', 'zwe': 'Zimbabwe',
};

/**
 * Normalize a free-text / ISO country into a canonical, board-ready name so the
 * value sent as a location parameter is consistent regardless of how the model
 * phrased it. Unrecognized inputs pass through trimmed (boards accept a plain
 * country name). Pure + testable.
 */
export function normalizeCountry(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const key = s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return COUNTRY_ALIASES[key] || s;
}

// Recognize a target that is JUST a country (e.g. "Canada", "United States").
// Unlike normalizeCountry (which passes unrecognized input through), this returns
// null for anything not a known country — so a single-word CITY ("Berlin") is not
// mistaken for a country. Used by the adherence auditor to switch into
// country-membership mode instead of city/subdivision matching.
function detectCountryTarget(seg) {
  const key = String(seg || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  return COUNTRY_ALIASES[key] || null;
}

// Countries recognized in ANY comma slot ("USA, Denver, Colorado"). Every other
// country counts only as the final slot, because many US/Canadian places share a
// country's name ("Lebanon, PA", "Jordan, MN", "Mexico, MO", "Peru, IN").
const ANY_SLOT_COUNTRIES = new Set([
  'United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand',
  'Ireland', 'Germany', 'France', 'India', 'Singapore',
]);

// US state code ↔ full name (plus DC and the USPS-recognized territories — same
// postal-code shape, and a job legitimately posted in one is a US job by any
// reasonable reading of a "United States" search). The adherence check derives
// a state token from the canonical ("Denver, CO" → "co"), but job boards spell
// the state out far more often than they use the 2-letter code ("Golden,
// Colorado, USA") — so we resolve the token to its code and match BOTH
// spellings, else an in-state suburb reads as out-of-area. Keys are codes;
// values keep their spaces for the word-boundary regex.
const US_STATES = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri',
  mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey',
  nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio',
  ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina',
  sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  dc: 'district of columbia',
  // USPS territories: same postal-code shape, so "Tamuning, GU" resolves to a
  // subdivision of the United States.
  as: 'american samoa', gu: 'guam', mp: 'northern mariana islands',
  pr: 'puerto rico', vi: 'virgin islands',
};

// Canadian provinces/territories — same code↔name shape as US_STATES, so a search
// for "Whitby, Ontario" counts a same-province job that lists only the code
// ("Toronto, ON") as in-area instead of off-target.
const CA_PROVINCES = {
  ab: 'alberta', bc: 'british columbia', mb: 'manitoba', nb: 'new brunswick',
  nl: 'newfoundland and labrador', ns: 'nova scotia', nt: 'northwest territories',
  nu: 'nunavut', on: 'ontario', pe: 'prince edward island', qc: 'quebec',
  sk: 'saskatchewan', yt: 'yukon',
};

// Combined subdivision lookup (US states + Canadian provinces); codes don't collide.
const SUBDIVISIONS = { ...US_STATES, ...CA_PROVINCES };

const SUBDIVISION_COUNTRY = Object.fromEntries([
  ...Object.keys(US_STATES).map(code => [code, 'United States']),
  ...Object.keys(CA_PROVINCES).map(code => [code, 'Canada']),
]);

// Resolve an alpha-only token ("co", "newyork") to its subdivision code, or ''.
function subdivisionCodeForAlpha(key) {
  if (SUBDIVISIONS[key]) return key;
  for (const [candidate, name] of Object.entries(SUBDIVISIONS)) {
    if (name.replace(/\s/g, '') === key) return candidate;
  }
  return '';
}

function normalizedLocationKey(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Normalize a US state or Canadian province/territory into the representation
 * that job boards handle consistently: US subdivisions use USPS codes; Canadian
 * ones use their full names. Returns empty fields for an unknown region so
 * arbitrary regions ("Bay Area", "Greater Toronto Area") retain their text.
 */
function normalizeSubdivision(raw, country = '') {
  const key = normalizedLocationKey(raw).replace(/[^a-z]/g, '');
  if (!key) return { code: '', label: '', country: '' };
  const code = subdivisionCodeForAlpha(key);
  if (!code) return { code: '', label: '', country: '' };
  const subdivisionCountry = SUBDIVISION_COUNTRY[code];
  const canonicalCountry = normalizeCountry(country);
  // Do not turn an invalid mixture such as "Ontario, USA" into a quietly
  // plausible target. The explicit country remains authoritative; callers can
  // expose the mismatch using `countryConflict` from normalizeLocationInput.
  if (canonicalCountry && subdivisionCountry !== canonicalCountry) {
    return { code: '', label: '', country: '' };
  }
  return {
    code,
    label: subdivisionCountry === 'United States' ? code.toUpperCase() : SUBDIVISIONS[code].replace(/\b\w/g, c => c.toUpperCase()),
    fullName: SUBDIVISIONS[code].replace(/\b\w/g, c => c.toUpperCase()),
    country: subdivisionCountry,
  };
}

/**
 * Deterministically classify a human-entered or board-ready location. This is
 * deliberately geography-light: it recognizes countries plus the US/Canadian
 * subdivisions we can safely normalize, without guessing a country for a bare
 * city. `boardReady` is the canonical filter text:
 *
 *   Canada                         → Canada
 *   USA                            → United States
 *   Ontario, Canada                → Ontario, Canada
 *   Colorado, USA                  → Colorado, United States
 *   Toronto, Ontario, Canada       → Toronto, Ontario, Canada
 *   Denver, Colorado, USA          → Denver, CO
 *
 * `scope` makes source policy straightforward: country, subdivision, city, or
 * unknown. `countryCode` is intentionally limited to the two jurisdictions
 * whose source behavior is explicitly supported by this product (CA / US).
 * Other recognized countries retain their canonical country name but return a
 * null code rather than receiving a fabricated ISO code.
 */
export function normalizeLocationInput(raw) {
  const input = String(raw || '').trim();
  const empty = {
    input,
    boardReady: '',
    country: '',
    countryCode: null,
    countryExplicit: false,
    countryConflict: false,
    subdivision: '',
    subdivisionCode: '',
    city: '',
    scope: 'unknown',
  };
  if (!input) return empty;

  const segments = input.split(',').map(part => part.trim()).filter(Boolean);
  if (!segments.length) return empty;

  // Recognized country aliases may occur in any comma-separated slot. In normal
  // inputs it is last; accepting "USA, Denver, Colorado" makes normalization
  // resilient to a board's reordered display without changing its meaning.
  let country = '';
  let countryIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    const detected = detectCountryTarget(segments[i]);
    if (detected && (i === segments.length - 1 || ANY_SLOT_COUNTRIES.has(detected))) {
      country = detected; countryIndex = i; break;
    }
  }
  const placeSegments = segments.filter((_, index) => index !== countryIndex);

  // Prefer a non-first subdivision ("Denver, Colorado"), preserving the
  // existing Washington, DC rule: a first segment is a subdivision only when
  // it is the entire remaining location ("Colorado, USA").
  let subdivisionIndex = -1;
  let subdivision = { code: '', label: '', country: '' };
  for (let i = 1; i < placeSegments.length; i++) {
    const candidate = normalizeSubdivision(placeSegments[i], country);
    if (candidate.code) { subdivisionIndex = i; subdivision = candidate; break; }
  }
  if (!subdivision.code && placeSegments.length === 1) {
    const candidate = normalizeSubdivision(placeSegments[0], country);
    if (candidate.code) { subdivisionIndex = 0; subdivision = candidate; }
  }

  const inferredCountry = subdivision.country;
  const countryConflict = !!country && !!inferredCountry && country !== inferredCountry;
  // normalizeSubdivision intentionally refuses a known subdivision that
  // contradicts an explicit country. Detect the contradiction independently so
  // users of this helper can reject it instead of accidentally searching it.
  let conflictingSubdivision = null;
  if (country && !subdivision.code) {
    for (const segment of placeSegments) {
      const candidate = normalizeSubdivision(segment);
      if (candidate.code && candidate.country !== country) { conflictingSubdivision = candidate; break; }
    }
  }
  const hasConflict = countryConflict || !!conflictingSubdivision;
  if (!country && inferredCountry) country = inferredCountry;

  const citySegments = subdivisionIndex > 0 ? placeSegments.slice(0, subdivisionIndex) : (subdivisionIndex === -1 ? placeSegments : []);
  const city = citySegments.join(', ');
  const countryCode = country === 'United States' ? 'US' : country === 'Canada' ? 'CA' : null;
  const scope = city ? 'city' : subdivision.code ? 'subdivision' : country ? 'country' : placeSegments.length ? 'city' : 'unknown';

  let boardReady = '';
  if (!hasConflict) {
    if (city) {
      boardReady = subdivision.label ? `${city}, ${subdivision.label}` : city;
      if (country && country !== 'United States') boardReady += `, ${country}`;
    } else if (subdivision.label) {
      // A bare "CO" is ambiguous as free text (especially in Google queries)
      // and loses the country boundary the user explicitly requested. State-only
      // scopes stay human-readable; city scopes above retain compact "Denver, CO".
      boardReady = country === 'United States'
        ? `${subdivision.fullName}, United States`
        : `${subdivision.fullName}, ${country || subdivision.country}`;
    } else if (country) {
      boardReady = country;
    } else {
      // Preserve an unknown but place-shaped city/region verbatim. This is an
      // explicit non-guess: no country code/scope is inferred from it.
      boardReady = placeSegments.join(', ');
    }
  }

  return {
    input,
    boardReady,
    country,
    countryCode,
    countryExplicit: countryIndex !== -1,
    countryConflict: hasConflict,
    subdivision: subdivision.fullName || subdivision.label,
    subdivisionCode: subdivision.code ? subdivision.code.toUpperCase() : '',
    city,
    scope: hasConflict ? 'unknown' : scope,
  };
}
