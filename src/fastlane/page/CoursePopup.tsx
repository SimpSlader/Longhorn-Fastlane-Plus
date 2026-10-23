/**
 * UT Registration Plus's own course popup (description, RateMyProf/CES/syllabi links, grade distribution),
 * opened from Fastlane's calendar. It renders in UTRP's shadow root so its styles never touch the Fastlane page.
 */
import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import type { ThemeName } from '@shared/types/Theme';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DialogProvider from '@views/components/common/DialogProvider/DialogProvider';
import ShadowRootContainer from '@views/components/common/ExtensionRoot/ShadowRootContainer';
import CourseCatalogInjectedPopup from '@views/components/injected/CourseCatalogInjectedPopup/CourseCatalogInjectedPopup';
import { ThemeContext } from '@views/contexts/ThemeContext';
import { useMemo, useState } from 'react';
import type { SectionRecord } from '../core/sections';
import { courseFromSection } from '../services/planningService';

const queryClient = new QueryClient();

export default function CoursePopup({ section, onClosed }: { section: SectionRecord; onClosed: () => void }) {
    const [open, setOpen] = useState(true);
    const [theme, setTheme] = useState<ThemeName>('light');
    const course = useMemo(
        () => (section.course ? new Course(section.course as Serialized<Course>) : courseFromSection(section)),
        [section]
    );
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeContext.Provider value={{ theme, setTheme }}>
                <ShadowRootContainer theme={theme}>
                    <DialogProvider>
                        <CourseCatalogInjectedPopup
                            course={course}
                            open={open}
                            onClose={() => setOpen(false)}
                            afterLeave={onClosed}
                        />
                    </DialogProvider>
                </ShadowRootContainer>
            </ThemeContext.Provider>
        </QueryClientProvider>
    );
}
