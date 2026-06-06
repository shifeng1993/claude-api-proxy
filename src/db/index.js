import {DataTypes, Sequelize} from 'sequelize';

const DB_DIALECT = process.env.DB_DIALECT || 'mysql';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'claude_api_proxy';

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
    await ensureTenantCredentialColumns();
    await ensureCopilotCredentialColumns();
    await sequelize.sync();
    await ensureTenantCredentialColumns();
    await ensureCopilotCredentialColumns();
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

async function ensureCopilotCredentialColumns() {
    const queryInterface = sequelize.getQueryInterface();
    const table = 'tenant_copilot_credentials';
    let columns;
    try {
        columns = await queryInterface.describeTable(table);
    } catch {
        return;
    }

    const definitions = {
        avatar_url: {type: DataTypes.TEXT, allowNull: true},
        proxy: {type: DataTypes.STRING, allowNull: true},
        skip_tls_verify: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
        account_type: {type: DataTypes.STRING, allowNull: false, defaultValue: 'individual'},
        vscode_version: {type: DataTypes.STRING, allowNull: false, defaultValue: '1.109.2'},
        is_active: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
        sort_order: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0}
    };

    for (const [name, definition] of Object.entries(definitions)) {
        if (!columns[name]) await queryInterface.addColumn(table, name, definition);
    }
}

export {sequelize};
