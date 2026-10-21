import 'src/fastlane/page/fastlane.css';

import renderRoot from '@shared/util/renderRoot';
import { StrictMode } from 'react';
import App from 'src/fastlane/page/App';

renderRoot(
    <StrictMode>
        <App />
    </StrictMode>
);
