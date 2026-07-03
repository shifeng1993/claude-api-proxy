import {DataTypes, Sequelize} from 'sequelize';

const DB_DIALECT = process.env.DB_DIALECT || 'mysql';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'claude_api_proxy';
const RETIRED_SERVICE_NAMES = [['co', 'pilot'].join('')];

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
    dialect: DB_DIALECT,
    host: DB_HOST,
    port: DB_PORT,
    logging: false,
    define: {
        freezeTableName: true,
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        underscored: true
    },
    pool: {
        max: 10,
        min: 2,
        acquire: 30000,
        idle: 10000
    }
});

export async function initDb() {
    await sequelize.authenticate();
    await dropRetiredServiceTables();
    await ensureTenantCredentialColumns();
    await ensureTenantUpstreamColumns();
    await sequelize.sync();
    await dropRetiredServiceTables();
    await ensureTenantCredentialColumns();
    await ensureTenantUpstreamColumns();
}

async function dropRetiredServiceTables() {
    const queryInterface = sequelize.getQueryInterface();
    for (const serviceName of RETIRED_SERVICE_NAMES) {
        const table = `tenant_${serviceName}_credentials`;
        try {
            await queryInterface.describeTable(table);
        } catch {
            continue;
        }
        await queryInterface.dropTable(table);
    }
}

async function ensureTenantCredentialColumns() {
    const queryInterface = sequelize.getQueryInterface();
    const table = 'tenant_credentials';
    let columns;
    try {
        columns = await queryInterface.describeTable(table);
    } catch {
        return;
    }
    if (!columns.sort_order) {
        await queryInterface.addColumn(table, 'sort_order', {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0
        });
    }
}

async function ensureTenantUpstreamColumns() {
    const queryInterface = sequelize.getQueryInterface();
    const table = 'tenant_upstreams';
    let columns;
    try {
        columns = await queryInterface.describeTable(table);
    } catch {
        return;
    }

    if (!columns.ws_mode) {
        await queryInterface.addColumn(table, 'ws_mode', {
            type: DataTypes.STRING,
            allowNull: false,
            defaultValue: 'ctx_pool'
        });
    }
    if (!columns.disable_responses_continuation) {
        await queryInterface.addColumn(table, 'disable_responses_continuation', {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false
        });
    }
}

export {sequelize};
