/**
 * @swagger
 * tags:
 *   name: Project
 *   description: Project management APIs
 */

/**
 * @swagger
 * /api/project/create-project:
 *   post:
 *     summary: Create a new project
 *     tags: [Project]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID
 *     responses:
 *       200:
 *         description: Project created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 projectPath:
 *                   type: string
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/upload-start-dev:
 *   post:
 *     summary: Upload project archive and start the dev server
 *     tags: [Project]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - file
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Project archive (.zip)
 *               basePath:
 *                 type: string
 *                 description: Base path (Vite projects only)
 *     responses:
 *       200:
 *         description: Uploaded and dev server started
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
 *         description: Invalid parameters or file format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/get-project-content:
 *   get:
 *     summary: Get project content
 *     tags: [Project]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 files:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       contents:
 *                         type: string
 *                       binary:
 *                         type: boolean
 *                       sizeExceeded:
 *                         type: boolean
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/backup-current-version:
 *   post:
 *     summary: Backup the current version
 *     tags: [Project]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - codeVersion
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID
 *               codeVersion:
 *                 type: string
 *                 description: Code version
 *     responses:
 *       200:
 *         description: Backup successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 zipPath:
 *                   type: string
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/export-project:
 *   get:
 *     summary: Export project as a ZIP archive
 *     tags: [Project]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project ZIP file download
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/get-project-content-by-version:
 *   get:
 *     summary: Get project content for a specific version
 *     tags: [Project]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: Project ID
 *       - in: query
 *         name: codeVersion
 *         required: true
 *         schema:
 *           type: string
 *         description: Code version
 *     responses:
 *       200:
 *         description: Project content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 files:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       contents:
 *                         type: string
 *                       binary:
 *                         type: boolean
 *                       sizeExceeded:
 *                         type: boolean
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

export default {};
