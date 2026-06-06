import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const TenantState = sequelize.define('tenant_states', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true
    },
    current_index: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    disabled_indexes: {
        type: DataTypes.TEXT,
        defaultValue: '[]',
        get() {
            const val = this.getDataValue('disabled_indexes');
            return val ? JSON.parse(val) : [];
        },
        set(val) {
            this.setDataValue('disabled_indexes', JSON.stringify(val || []));
        }
    },
    active_upstream_index: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    saved_at: {
        type: DataTypes.STRING
    }
}, {
    indexes: [
        {fields: ['tenant_id']}
    ]
});
