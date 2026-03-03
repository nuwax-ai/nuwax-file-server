/**
 * @swagger
 * tags:
 *   name: Build
 *   description: 构建和开发服务器管理相关接口
 */

/**
 * @swagger
 * /api/build/start-dev:
 *   get:
 *     summary: 启动开发服务器
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *       - in: query
 *         name: basePath
 *         schema:
 *           type: string
 *         description: 基础路径(仅Vite项目)
 *     responses:
 *       200:
 *         description: 启动成功
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/build/build:
 *   get:
 *     summary: 构建项目
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *       - in: query
 *         name: basePath
 *         schema:
 *           type: string
 *         description: 基础路径(仅Vite项目)
 *     responses:
 *       200:
 *         description: 构建成功
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
 *         description: 参数错误或并发已满
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/build/stop-dev:
 *   get:
 *     summary: 停止开发服务器
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *       - in: query
 *         name: pid
 *         required: true
 *         schema:
 *           type: number
 *         description: 进程ID
 *     responses:
 *       200:
 *         description: 停止成功
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
 *     summary: 重启开发服务器
 *     tags: [Build]
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *         description: 项目ID
 *       - in: query
 *         name: pid
 *         schema:
 *           type: number
 *         description: 进程ID(可选)
 *       - in: query
 *         name: basePath
 *         schema:
 *           type: string
 *         description: 基础路径(仅Vite项目)
 *     responses:
 *       200:
 *         description: 重启成功
 */

/**
 * @swagger
 * /api/build/list-dev:
 *   get:
 *     summary: 列出运行中的开发服务器
 *     tags: [Build]
 *     responses:
 *       200:
 *         description: 成功获取列表
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
 *     summary: 解析构建错误信息
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
 *         description: 解析成功
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
