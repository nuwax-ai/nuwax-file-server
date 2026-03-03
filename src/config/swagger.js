import swaggerJsdoc from "swagger-jsdoc";
import config from "../appConfig/index.js";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Application Builder API",
      version: "1.0.0",
      description: "应用构建系统 API 文档",
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: `http://localhost:${config.PORT}`,
        description: `${config.NODE_ENV} 环境`,
      },
    ],
    tags: [
      { name: "Build", description: "构建相关接口" },
      { name: "Project", description: "项目管理接口" },
      { name: "Code", description: "代码提交接口" },
    ],
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            error: {
              type: "object",
              properties: {
                type: { type: "string", example: "VALIDATION_ERROR" },
                message: { type: "string", example: "项目ID不能为空" },
                timestamp: { type: "string", format: "date-time" },
                requestId: { type: "string" },
                details: { type: "object" },
              },
            },
          },
        },
        Success: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string" },
          },
        },
      },
    },
  },
  apis: ["./src/config/swagger/*.js"],
};

const specs = swaggerJsdoc(options);
export default specs;
