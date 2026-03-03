/**
 * @swagger
 * tags:
 *   name: Code
 *   description: 代码文件管理相关接口
 */

/**
 * @swagger
 * /api/project/submit-files-update:
 *   post:
 *     summary: 提交文件更新并重启开发服务器
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
 *                 description: 项目ID
 *               codeVersion:
 *                 type: string
 *                 description: 代码版本号
 *               files:
 *                 type: array
 *                 description: 文件列表
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
 *                 description: 基础路径(可选)
 *               pid:
 *                 type: number
 *                 description: 进程ID(可选)
 *     responses:
 *       200:
 *         description: 提交成功
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

/**
 * @swagger
 * /api/project/upload-single-file:
 *   post:
 *     summary: 上传单个文件
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
 *                 description: 项目ID
 *               codeVersion:
 *                 type: string
 *                 description: 代码版本号
 *               filePath:
 *                 type: string
 *                 description: 文件在项目中的相对路径
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: 文件内容
 *     responses:
 *       200:
 *         description: 上传成功
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
 *         description: 参数错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */

export default {};
