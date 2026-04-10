/**
 * @swagger
 * tags:
 *   name: Build
 *   description: Build and dev server management APIs
 */

/**
 * @swagger
 * /api/build/start-dev:
 *   get:
 *     summary: Start the dev server
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *       - in: query
 *         name: basePath
 *         schema:
 *           type: string
 *         description: Base path (Vite projects only)
 *     responses:
 *       200:
 *         description: Dev server started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 projectId:
 *                   type: string
 *                 pid:
 *                   type: number
 *                 port:
 *                   type: number
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/build/build:
 *   get:
 *     summary: Build the project
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *       - in: query
 *         name: basePath
 *         schema:
 *           type: string
 *         description: Base path (Vite projects only)
 *     responses:
 *       200:
 *         description: Build successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 projectId:
 *                   type: string
 *       400:
 *         description: Invalid parameters or max concurrency reached
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/build/stop-dev:
 *   get:
 *     summary: Stop the dev server
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *       - in: query
 *         name: pid
 *         required: true
 *         schema:
 *           type: number
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Dev server stopped
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 projectId:
 *                   type: string
 *                 pid:
 *                   type: number
 */

/**
 * @swagger
 * /api/build/restart-dev:
 *   get:
 *     summary: Restart the dev server
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *       - in: query
 *         name: pid
 *         schema:
 *           type: number
 *         description: Process ID (optional)
 *       - in: query
 *         name: basePath
 *         schema:
 *           type: string
 *         description: Base path (Vite projects only)
 *     responses:
 *       200:
 *         description: Dev server restarted
 */

/**
 * @swagger
 * /api/build/list-dev:
 *   get:
 *     summary: List running dev servers
 *     tags: [Build]
 *     responses:
 *       200:
 *         description: List retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 list:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       projectId:
 *                         type: string
 *                       pid:
 *                         type: number
 *                       port:
 *                         type: number
 *                       startedAt:
 *                         type: number
 */

/**
 * @swagger
 * /api/build/parse-build-error:
 *   post:
 *     summary: Parse build error output
 *     tags: [Build]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - errorMessage
 *             properties:
 *               projectId:
 *                 type: string
 *               errorMessage:
 *                 type: string
 *     responses:
 *       200:
 *         description: Parsed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */

export default {};
