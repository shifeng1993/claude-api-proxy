import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const Feedback = sequelize.define('feedbacks', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    category: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: '其他'
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    source: {
        type: DataTypes.STRING(20)
    },
    username: {
        type: DataTypes.STRING(100)
    },
    tenant_id: {
        type: DataTypes.STRING(100)
    },
    status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending'
    },
    handler: {
        type: DataTypes.STRING(100)
    },
    resolve_note: {
        type: DataTypes.TEXT
    },
    attachments: {
        type: DataTypes.TEXT,
        get() {
            const raw = this.getDataValue('attachments');
            if (!raw) return [];
            try { return JSON.parse(raw); } catch { return []; }
        },
        set(val) {
            this.setDataValue('attachments', JSON.stringify(val));
        }
    }
}, {
    indexes: [
        {fields: ['status']},
        {fields: ['created_at']}
    ]
});
