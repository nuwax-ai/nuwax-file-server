/**
 * @swagger
 * tags:
 *   name: Project
 *   description: 项目管理相关接口
 */

/**
 * @swagger
 * /api/project/create-project:
 *   post:
 *     summary: 创建新项目
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
 *                 description: 项目ID
 *     responses:
 *       200:
 *         description: 项目创建成功
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/upload-start-dev:
 *   post:
 *     summary: 上传项目文件并启动开发服务器
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
 *                 description: 项目ID
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: 项目压缩包(.zip)
 *               basePath:
 *                 type: string
 *                 description: 基础路径(仅Vite项目)
 *     responses:
 *       200:
 *         description: 上传并启动成功
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
 *         description: 参数错误或文件格式错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/get-project-content:
 *   get:
 *     summary: 获取项目内容
 *     tags: [Project]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *     responses:
 *       200:
 *         description: 成功获取项目内容
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/backup-current-version:
 *   post:
 *     summary: 备份当前版本
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
 *                 description: 项目ID
 *               codeVersion:
 *                 type: string
 *                 description: 代码版本号
 *     responses:
 *       200:
 *         description: 备份成功
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/export-project:
 *   get:
 *     summary: 导出项目为压缩包
 *     tags: [Project]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *     responses:
 *       200:
 *         description: 成功下载项目压缩包
 *         content:
 *           application/zip:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/get-project-content-by-version:
 *   get:
 *     summary: 获取指定版本的项目内容
 *     tags: [Project]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *       - in: query
 *         name: codeVersion
 *         required: true
 *         schema:
 *           type: string
 *         description: 代码版本号
 *     responses:
 *       200:
 *         description: 成功获取项目内容
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

export default {};
