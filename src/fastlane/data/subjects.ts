/** UT 2026–27 A–Z fields of study, separate from semester offerings.
 * Source: https://catalog.utexas.edu/general-information/coursesatoz/
 * Seeing a subject here does NOT mean sections are scheduled or cached.
 */
const RAW_SUBJECTS = "ACC|Accounting\nACF|Actuarial Foundations\nADV|Advertising\nASE|Aerospace Engineering\nAFR|African and African Diaspora Studies\nAFS|Air Force Science\nASL|American Sign Language\nAMS|American Studies\nAHC|Ancient History and Classical Civilization\nANT|Anthropology\nAAR|Applied Archaeology\nARA|Arabic\nARE|Architectural Engineering\nARI|Architectural Interior Design\nARC|Architecture\nAED|Art Education\nARH|Art History\nA I|Artificial Intelligence\nAET|Arts and Entertainment Technologies\nAAS|Asian American Studies\nANS|Asian Studies\nAST|Astronomy\nAUD|Audiology\nBSN|Bassoon\nBHD|Behavioral and Humanities Data Science\nBEN|Bengali\nBCH|Biochemistry\nBIO|Biology\nBME|Biomedical Engineering\nBCM|Bosnian, Croatian, Montenegrin, Serbian\nBDP|Bridging Disciplines\nB A|Business Administration\nBAH|Business Administration Honors\nBAX|Business Analytics\nBGS|Business, Government, and Society\nCHE|Chemical Engineering\nCH|Chemistry\nCHI|Chinese\nC T|Civic Thought\nCIV|Civics\nC E|Civil Engineering\nCLA|Clarinet\nC C|Classical Civilization\nCED|Classical Education\nCGS|Cognitive Science\nCOM|Communication\nCLD|Communication and Leadership\nCMS|Communication Studies\nCRP|Community and Regional Planning\nC L|Comparative Literature\nCOE|Computational Engineering\nCSE|Computational Science, Engineering, and Mathematics\nC S|Computer Science\nCON|Conducting\nCTI|Core Texts and Ideas\nCRW|Creative Writing\nCDI|Critical Disability Studies\nEDC|Curriculum and Instruction\nCZ|Czech\nDAN|Danish\nDSC|Data Science\nD S|Decision Science\nDES|Design\nDEV|Developmental Studies\nDGI|Digital Game Industries\nD B|Double Bass\nDRS|Drum Set\nDCH|Dutch\nEEB|Ecology, Evolution, and Behavior\nECO|Economics\nEDU|Education\nELP|Educational Leadership and Policy\nEDP|Educational Psychology\nECE|Electrical and Computer Engineering\nEER|Energy and Earth Resources\nEMA|Energy Management\nENM|Engineering Management\nE M|Engineering Mechanics\nE S|Engineering Studies\nE|English\nESL|English as a Second Language\nENS|Ensemble\nEVE|Environmental Engineering\nEVS|Environmental Science\nEUP|Euphonium\nEUS|European Studies\nFIN|Finance\nF A|Fine Arts\nFLU|Flute\nFR|French\nF C|French Civilization\nF H|French Horn\nG E|General Engineering\nGRG|Geography\nGEO|Geological Sciences\nGER|German\nGSD|German, Scandinavian, and Dutch Studies\nGPS|Global Policy Studies\nGOV|Government\nGRS|Graduate School\nG B|Great Books\nGK|Greek\nGUI|Guitar\nHAR|Harp\nHSC|Harpsichord\nH S|Health and Society\nHED|Health Education\nHEB|Hebrew\nHIN|Hindi\nHIS|History\nHDF|Human Development and Family Sciences\nHDO|Human Dimensions of Organizations\nH E|Human Ecology\nHMN|Humanities\nHHM|Humanities, Health, and Medicine\nILA|Iberian and Latin American Languages and Cultures\nLAL|Indigenous Languages of Latin America\nI|Informatics\nISP|Information Security and Privacy\nINF|Information Studies\nITD|Integrated Design\nINB|Integrative Biology\nI B|International Business\nIRG|International Relations and Global Studies\nITL|Italian\nITC|Italian Civilization\nJPN|Japanese\nJ S|Jewish Studies\nJ|Journalism\nKIN|Kinesiology\nKOR|Korean\nLAR|Landscape Architecture\nLTC|Language Teaching and Coordination\nLAT|Latin\nLAS|Latin American Studies\nLAW|Law\nLEB|Legal Environment of Business\nL A|Liberal Arts\nLAH|Liberal Arts Honors\nLIN|Linguistics\nMAL|Malayalam\nMAN|Management\nMIS|Management Information Systems\nMFG|Manufacturing Systems Engineering\nMNS|Marine Science\nMKT|Marketing\nMSE|Materials Science and Engineering\nM|Mathematics\nM E|Mechanical Engineering\nMLS|Medical Laboratory Science\nMDV|Medieval Studies\nMAS|Mexican American Studies\nMIC|Microbiology\nMEL|Middle Eastern Languages and Cultures\nMES|Middle Eastern Studies\nM S|Military Science\nMOL|Molecular Biology\nMBS|Molecular Biosciences\nMUS|Music\nNSP|National Security Policy\nNSC|Natural Sciences\nN S|Naval Science\nNEU|Neuroscience\nNOR|Norwegian\nN E|Nuclear Engineering\nNRP|Nurse Professional\nN|Nursing\nNTR|Nutrition\nOBO|Oboe\nOPR|Opera\nO M|Operations Management\nORI|Operations Research and Industrial Engineering\nORG|Organ\nPER|Percussion\nPRF|Performance\nPRS|Persian\nPGE|Petroleum and Geosystems Engineering\nPGS|Pharmacy Graduate Studies\nPHM|Pharmacy PharmD\nPHL|Philosophy\nPPE|Philosophy, Politics, and Economics\nPED|Physical Education\nP S|Physical Science\nPHY|Physics\nPIA|Piano\nP B|Plant Biology\nPOL|Polish\nPOR|Portuguese\nPRC|Portuguese Civilization\nPSC|Prevention Science\nPSY|Psychology\nP A|Public Affairs\nPBH|Public Health\nP L|Public Leadership\nP R|Public Relations\nPSF|Public Safety\nRIM|Race, Indigeneity, and Migration\nRTF|Radio-Television-Film\nR E|Real Estate\nREC|Recorder\nR S|Religious Studies\nRHE|Rhetoric and Writing\nR M|Risk Management\nRBT|Robotics\nROM|Romanian\nRUS|Russian\nREE|Russian, East European, and Eurasian Studies\nSAN|Sanskrit\nSAX|Saxophone\nSCI|Science\nSTC|Science and Technology Commercialization\nSTM|Science, Technology, Engineering, and Mathematics Education\nSLE|Second Language Education\nSSE|Semiconductor Science and Engineering\nSEL|Slavic and Eurasian Languages\nS S|Social Science\nS W|Social Work\nSOC|Sociology\nSAL|South Asian Languages\nSPN|Spanish\nSPC|Spanish Civilization\nSED|Special Education\nSLH|Speech, Language, and Hearing Sciences\nSPB|Sports Production and Broadcasting\nSTA|Statistics\nSDS|Statistics and Data Sciences\nSTR|Strategy and Statecraft\nART|Studio Art\nSEE|Subsurface Energy Engineering\nSUS|Sustainability Studies\nSWA|Swahili\nSWE|Swedish\nTAM|Tamil\nTEL|Telugu\nTXA|Textiles and Apparel\nT D|Theatre and Dance\nTRO|Trombone\nTRU|Trumpet\nTBA|Tuba\nTUR|Turkish\nT C|Tutorial Course\nUKR|Ukrainian\nUGS|Undergraduate Studies\nU D|Urban Design\nURB|Urban Studies\nURD|Urdu\nUTL|UTeach-Liberal Arts\nUTS|UTeach-Natural Sciences\nVIB|Vibraphone\nVIA|Viola\nVIO|Violin\nV C|Violoncello\nVOI|Voice\nWGS|Women's and Gender Studies\nWRT|Writing\nYID|Yiddish\nYOR|Yoruba";

export interface Subject { code: string; name: string; }
export const UT_SUBJECTS: Subject[] = RAW_SUBJECTS.split('\n').map(line => {
    const pipe = line.indexOf('|');
    return { code: line.slice(0, pipe), name: line.slice(pipe + 1) };
}).sort((a, b) => a.name.localeCompare(b.name));

export function subjectForCode(code: string): Subject | undefined {
    return UT_SUBJECTS.find(item => item.code === code.toUpperCase().trim());
}

/** Merge any legacy/current subject codes observed in real sections. */
export function availableSubjects(codes: Iterable<string>): Subject[] {
    const byCode = new Map(UT_SUBJECTS.map(s => [s.code, s]));
    for (const code of codes) {
        const normalized = code.toUpperCase().trim();
        if (normalized && !byCode.has(normalized)) byCode.set(normalized, { code: normalized, name: normalized });
    }
    return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * Official UT course-schedule field search. This opens UT in the student's browser,
 * using their own university session. It does not scrape pages in the background.
 */
export function utSubjectScheduleUrl(semester: string, subject: string): string {
    const match = semester.match(/^(Spring|Summer|Fall) (20\d{2})$/);
    const code = subjectForCode(subject)?.code;
    if (!match || !code) return 'https://registrar.utexas.edu/schedules';
    const season = match[1] as 'Spring' | 'Summer' | 'Fall';
    const term = match[2] + ({ Spring: '2', Summer: '6', Fall: '9' }[season]);
    const params = new URLSearchParams({ fos_fl: code, level: 'U', search_type_main: 'FIELD' });
    return 'https://utdirect.utexas.edu/apps/registrar/course_schedule/' + term + '/results/?' + params.toString();
}
