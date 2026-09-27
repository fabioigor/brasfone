'use strict';
const app = require('./app');
const PORT = parseInt(process.env.PORT || '3080', 10);
app.listen(PORT, () => console.log(`ROI calculator on http://localhost:${PORT} ${process.env.DRY_RUN === '1' ? '(DRY_RUN)' : ''}`));
