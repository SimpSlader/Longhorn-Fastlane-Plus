/**
 * Offline fixtures shaped like UT's public course-schedule results table and add/drop screen.
 * Course codes and instructors are real catalog courses so the bundled historical grade data
 * resolves; unique numbers, times and rooms are illustrative for the demo only.
 */

interface DemoSection {
    unique: string;
    days: string[];
    hours: string[];
    rooms: string[];
    mode: string;
    instructor: string;
    status: string;
    core?: string;
    flags?: string[];
}

interface DemoCourse {
    header: string;
    sections: DemoSection[];
}

export const DEMO_SEMESTER_CODE = '20272';

export const DEMO_COURSES: DemoCourse[] = [
    {
        header: 'MUS 302L INTRODUCTION TO WESTERN MUSIC',
        sections: [
            {
                unique: '23095',
                days: [],
                hours: [],
                rooms: [],
                mode: 'Internet',
                instructor: 'MIDDLETON, J',
                status: 'open',
                core: 'Visual and Performing Arts',
            },
            {
                unique: '23100',
                days: ['MW'],
                hours: ['1:00 p.m.-2:30 p.m.'],
                rooms: ['WB'],
                mode: 'Internet',
                instructor: 'PENATE, M',
                status: 'open',
                core: 'Visual and Performing Arts',
            },
        ],
    },
    {
        header: 'C C 303 INTRODUCTION TO CLASSICAL MYTHOLOGY',
        sections: [
            {
                unique: '33515',
                days: [],
                hours: [],
                rooms: [],
                mode: 'Internet',
                instructor: 'NETHERCUT, J',
                status: 'closed',
                core: 'Visual and Performing Arts',
            },
        ],
    },
    {
        header: 'C C 302 INTRODUCTION TO ANCIENT ROME',
        sections: [
            {
                unique: '33505',
                days: ['TTH'],
                hours: ['9:30 a.m.-11:00 a.m.'],
                rooms: ['WAG 201'],
                mode: 'Face-to-face',
                instructor: 'RIGGSBY, A',
                status: 'open',
                core: 'Visual and Performing Arts',
            },
        ],
    },
    {
        header: 'ART 301 THE STUDIO EXPERIENCE',
        sections: [
            {
                unique: '20001',
                days: ['MWF'],
                hours: ['10:00 a.m.-11:00 a.m.'],
                rooms: ['ART 1.120'],
                mode: 'Face-to-face',
                instructor: 'SMITH, J',
                status: 'open',
                core: 'Visual and Performing Arts',
            },
        ],
    },
    {
        header: 'ARH 301 SURVEY OF ANCIENT THROUGH MEDIEVAL ART',
        sections: [
            {
                unique: '20004',
                days: ['MW'],
                hours: [''],
                rooms: [''],
                mode: 'Face-to-face',
                instructor: 'SMITH, J',
                status: 'open',
                core: 'Visual and Performing Arts',
            },
        ],
    },
    {
        header: 'T D 301 INTRODUCTION TO THEATRE',
        sections: [
            {
                unique: '27425',
                days: ['TTH'],
                hours: ['2:00 p.m.-3:30 p.m.'],
                rooms: ['WB'],
                mode: 'Internet',
                instructor: 'SMITH, J',
                status: 'open',
                core: 'Visual and Performing Arts',
            },
        ],
    },
    {
        header: 'NTR 306 FUNDAMENTALS OF NUTRITION',
        sections: [
            {
                unique: '55675',
                days: ['TTH', 'F'],
                hours: ['12:30 p.m.-2:00 p.m.', '2:00 p.m.-4:00 p.m.'],
                rooms: ['PAI 3.02', 'PAI 3.14'],
                mode: 'Face-to-face',
                instructor: 'SMITH, J',
                status: 'open',
                core: 'Natural Science and Technology, Part I',
            },
        ],
    },
    {
        header: 'UGS 302 FIRST-YEAR SIGNATURE COURSE',
        sections: [
            {
                unique: '65555',
                days: ['MWF'],
                hours: ['9:00 a.m.-10:00 a.m.'],
                rooms: ['GEA 105'],
                mode: 'Face-to-face',
                instructor: 'SMITH, J',
                status: 'open',
                core: 'First-Year Signature Course',
                flags: ['Writing'],
            },
        ],
    },
    {
        header: 'M 408C DIFFERENTIAL AND INTEGRAL CALCULUS',
        sections: [
            {
                unique: '53780',
                days: ['MWF', 'TTH'],
                hours: ['10:00 a.m.-11:00 a.m.', '11:00 a.m.-12:30 p.m.'],
                rooms: ['RLP 0.102', 'PMA 5.104'],
                mode: 'Face-to-face',
                instructor: 'SMITH, J',
                status: 'open',
                core: 'Mathematics',
            },
        ],
    },
];

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const spans = (xs: string[]) => xs.map(x => `<span>${esc(x)}</span>`).join('');

export function courseScheduleTableHtml(): string {
    const rows = DEMO_COURSES.map(course => {
        const header = `<tr><td class="course_header" colspan="11"><h2>${esc(course.header)}</h2></td></tr>`;
        const sections = course.sections
            .map(
                s => `<tr>
  <td data-th="Unique"><a href="#unique-${s.unique}">${s.unique}</a></td>
  <td data-th="Days">${spans(s.days)}</td>
  <td data-th="Hour">${spans(s.hours)}</td>
  <td data-th="Room">${spans(s.rooms)}</td>
  <td data-th="Instruction Mode">${esc(s.mode)}</td>
  <td data-th="Instructor"><span>${esc(s.instructor)}</span></td>
  <td data-th="Status">${esc(s.status)}</td>
  <td data-th="Flags"><ul>${(s.flags ?? []).map(f => `<li>${esc(f)}</li>`).join('')}</ul></td>
  <td data-th="Core"><ul>${s.core ? `<li title="${esc(s.core)}">${esc(s.core)}</li>` : ''}</ul></td>
</tr>`
            )
            .join('');
        return header + sections;
    }).join('');
    return `<table class="rwd-table results"><thead><tr><th>Unique</th><th>Days</th><th>Hour</th><th>Room</th><th>Instruction Mode</th><th>Instructor</th><th>Status</th><th>Flags</th><th>Core</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Mirrors the structure of UT's add/drop form (field names from public sources); divs instead of a table so the listing scraper ignores it. */
export const ADD_DROP_FORM_HTML = `
<div id="n_message"><span class="notification">Please select a registration action.</span></div>
<form id="demo-add-drop" name="regform" autocomplete="off">
  <div id="message" role="status"></div>
  <div id="message2"></div>
  <p><input type="radio" name="s_request" id="ds_request_STADD" value="STADD" checked>
     <label for="s_unique_add">REGISTER for or ADD</label> <input type="text" name="s_unique_add" id="s_unique_add" size="6" maxlength="5"></p>
  <p><input type="radio" name="s_request" id="s_request_STDRP" value="STDRP">
     <label for="s_unique_drop">DROP</label> <select name="s_unique_drop" id="s_unique_drop"><option value="">Select unique to:</option></select></p>
  <p><input type="radio" name="s_request" id="s_request_STSWP" value="STSWP">
     <select name="s_swap_unique_drop" id="s_swap_unique_drop"><option value="">Select unique to:</option></select>
     DROP DEPENDENT UPON successfully ADDING <input type="text" name="s_swap_unique_add" id="s_swap_unique_add" size="6" maxlength="5"></p>
  <input type="submit" name="s_submit" id="s_submit" value="Submit (simulated)">
</form>`;
