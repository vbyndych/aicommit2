import { testSuite } from 'manten';

import config from './config.js';
import registry from './registry.js';
import service from './service.js';

export default testSuite(({ runTestSuite }) => {
    runTestSuite(service);
    runTestSuite(config);
    runTestSuite(registry);
});
