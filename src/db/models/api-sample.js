import {DataTypes} from 'sequelize';
import {sequelize} from '../index.js';

export const ApiSample = sequelize.define('api_samples', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    tenant_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    service_type: {
        type: DataTypes.STRING,
        allowNull: false
    },
    username: {
        type: DataTypes.STRING
    },
    model: {
        type: DataTypes.STRING,
        defaultValue: 'unknown'
    },
    file_path: {
        type: DataTypes.STRING,
        allowNull: false
    },
    request_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    response_tokens: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    sampling_rate: {
        type: DataTypes.REAL,
        defaultValue: 0.2
    }
}, {
    indexes: [
        {fields: ['tenant_id', 'created_at']},
        {fields: ['created_at']}
    ]
});