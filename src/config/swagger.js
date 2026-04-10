import swaggerJsdoc from "swagger-jsdoc";
import config from "../appConfig/index.js";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Application Builder API",
      version: "1.0.0",
      description: "Application builder API documentation",
      contact: {
        name: "API Support",
      },
    },
    servers: [
      {
        url: `http://localhost:${config.PORT}`,
        description: `${config.NODE_ENV} environment`,
      },
    ],
    tags: [
      { name: "Build", description: "Build related interfaces" },
      { name: "Project", description: "Project management interfaces" },
      { name: "Code", description: "Code submission interfaces" },
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
                message: { type: "string", example: "Project ID cannot be empty" },
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
