/**
 * @swagger
 * tags:
 *   name: Code
 *   description: Code file management APIs
 */

/**
 * @swagger
 * /api/project/submit-files-update:
 *   post:
 *     summary: Submit file updates and restart the dev server
 *     tags: [Code]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - codeVersion
 *               - files
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID
 *               codeVersion:
 *                 type: string
 *                 description: Code version
 *               files:
 *                 type: array
 *                 description: Files to update
 *                 items:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     contents:
 *                       type: string
 *                     binary:
 *                       type: boolean
 *                     sizeExceeded:
 *                       type: boolean
 *               basePath:
 *                 type: string
 *                 description: Base path (optional)
 *               pid:
 *                 type: number
 *                 description: Process ID (optional)
 *     responses:
 *       200:
 *         description: Submitted successfully
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
 *                 restarted:
 *                   type: boolean
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/upload-single-file:
 *   post:
 *     summary: Upload a single file
 *     tags: [Code]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - projectId
 *               - codeVersion
 *               - file
 *               - filePath
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Project ID
 *               codeVersion:
 *                 type: string
 *                 description: Code version
 *               filePath:
 *                 type: string
 *                 description: Relative path of the file inside the project
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: File contents
 *     responses:
 *       200:
 *         description: Upload successful
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
 *                 restarted:
 *                   type: boolean
 *       400:
 *         description: Invalid parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

export default {};
