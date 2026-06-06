import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const TenantUpstream = sequelize.define('tenant_upstreams', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    name: {
        type: DataTypes.STRING
    },
    base_url: {
        type: DataTypes.STRING
    },
    api_key: {
        type: DataTypes.TEXT
    },
    proxy: {
        type: DataTypes.STRING
    },
    models: {
        type: DataTypes.TEXT,
        get() {
            const val = this.getDataValue('models');
            return val ? JSON.parse(val) : [];
        },
        set(val) {
            this.setDataValue('models', JSON.stringify(val || []));
        }
    },
    model_map: {
        type: DataTypes.TEXT,
        get() {
            const val = this.getDataValue('model_map');
            return val ? JSON.parse(val) : {};
        },
        set(val) {
            this.setDataValue('model_map', JSON.stringify(val || {}));
        }
    },
    model_auto: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    protocol: {
        type: DataTypes.STRING
    },
    retry_count: {
        type: DataTypes.INTEGER,
        defaultValue: 3
    },
    enabled: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    skip_tls_verify: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    }
}, {
    indexes: [
        {fields: ['tenant_id']}
    ]
});
