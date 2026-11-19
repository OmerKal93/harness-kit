#!/usr/bin/env node
// Fixture for runQaEvals hermetic tests (W11): prints non-JSON stdout to exercise the ERROR path.
'use strict';
process.stdout.write('not json{{{');
process.exit(1);
