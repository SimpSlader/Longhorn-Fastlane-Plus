import ExtensionRoot from '@views/components/common/ExtensionRoot/ExtensionRoot';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const HIDDEN_INPUT_ID = 'fastlane-mtg-days-input';

/**
 * UT's authenticated course-search markup is allowed to change independently of this extension.
 * Never remove or replace an unknown form wrapper, and restore its original nodes on unmount.
 */
export default function DaysCheckbox(): JSX.Element | null {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    const [daysValue, setDaysValue] = useState<number[]>(() => {
        const current = document.getElementById('mtg_days_st') as HTMLSelectElement | null;
        const bits = current?.value;
        return bits && /^[01]{6}$/.test(bits) ? [...bits].map(Number) : [0, 0, 0, 0, 0, 0];
    });
    const changedByUser = useRef(false);

    useEffect(() => {
        const daysDropdown = document.getElementById('mtg_days_st') as HTMLSelectElement | null;
        if (!daysDropdown) {
            // Many UT course-schedule landing/search pages do not have the advanced day filter.
            // Their native controls must remain usable; absence is not an extension error.
            return;
        }

        const formElement = daysDropdown.closest('.form_element');
        if (!formElement) {
            // Avoid "Cannot set properties of null (setting 'innerHTML')" if UT changes markup.
            console.warn('[Fastlane] UT day-filter wrapper not recognized; leaving native control intact.');
            return;
        }
        if (formElement.querySelector(`#${HIDDEN_INPUT_ID}`)) return;

        // Retain the actual DOM nodes, rather than destroying the university's inputs/event handlers
        // with innerHTML. This also lets an extension reload restore the original UT form.
        const originalChildren = Array.from(formElement.childNodes);
        const checkboxContainer = document.createElement('div');
        checkboxContainer.id = 'fastlane-mtg-days-picker';

        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.name = daysDropdown.name || 'mtg_days_st';
        hiddenInput.id = HIDDEN_INPUT_ID;
        hiddenInput.value = daysDropdown.value;

        const label = document.createElement('label');
        label.className = 'primary_label';
        label.htmlFor = HIDDEN_INPUT_ID;
        label.textContent = 'AND days';

        formElement.replaceChildren(label, hiddenInput, checkboxContainer);
        setContainer(checkboxContainer);

        return () => {
            // UT may have changed the markup after our enhancement. Restore only if the picker
            // is still mounted inside the wrapper we modified.
            if (formElement.contains(checkboxContainer)) formElement.replaceChildren(...originalChildren);
        };
    }, []);

    useEffect(() => {
        // Never overwrite a pre-existing UT search selection simply because React mounted.
        if (!changedByUser.current) return;
        const hiddenInput = document.getElementById(HIDDEN_INPUT_ID) as HTMLInputElement | null;
        if (hiddenInput) hiddenInput.value = daysValue.join('');
    }, [daysValue]);

    const handleDayChange = (position: number, checked: boolean) => {
        changedByUser.current = true;
        setDaysValue(prev => prev.map((value, i) => (i === position ? Number(checked) : value)));
    };

    if (!container) return null;
    return createPortal(
        <ExtensionRoot>
            <ul className='text-black font-[Verdana,_"Helvetica_Neue",_Helvetica,_Arial,_sans-serif]'>
                {days.map((day, index) => (
                    <li key={day}>
                        <input
                            type='checkbox'
                            id={`day_${day}`}
                            checked={daysValue[index] === 1}
                            onChange={e => handleDayChange(index, e.target.checked)}
                            className='form-checkbox m-[3px_3px_3px_4px]'
                        />{' '}
                        <label htmlFor={`day_${day}`}>{day}</label>
                    </li>
                ))}
            </ul>
        </ExtensionRoot>,
        container
    );
}
