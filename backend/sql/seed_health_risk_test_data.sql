-- ============================================================================
-- Text2SQL 模块测试数据初始化脚本
-- 用途：为 user_health_risk_assessment 及扩展表 user_nutrition_intervention 灌入
--      覆盖全风险等级、高龄(>=70)、低BMI(<18.5)、多次复测(USER001)、近7天分布的样本数据
-- 执行方式：
--   mysql -uroot -p123456 test_db < backend/sql/seed_health_risk_test_data.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_health_risk_assessment (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '记录ID',
    user_id VARCHAR(64) NOT NULL COMMENT '用户唯一标识',
    user_name VARCHAR(100) NOT NULL COMMENT '用户姓名',
    sex ENUM('男', '女', '其他') NOT NULL COMMENT '性别',
    age TINYINT UNSIGNED NOT NULL COMMENT '年龄',
    assessment_time DATETIME NOT NULL COMMENT '测评时间',
    assessment_count INT DEFAULT 1 COMMENT '测试次数',
    total_score TINYINT UNSIGNED NOT NULL COMMENT '总分',
    nutritional_impairment_score TINYINT UNSIGNED NOT NULL COMMENT '营养受损分',
    disease_severity_score TINYINT UNSIGNED NOT NULL COMMENT '疾病严重度分',
    age_score TINYINT UNSIGNED NOT NULL COMMENT '年龄分',
    assessment_basis TEXT COMMENT '评分依据说明',
    risk_level ENUM('无风险', '低风险', '中风险', '高风险') NOT NULL COMMENT '风险等级',
    bmi DECIMAL(4,2) COMMENT 'BMI指数',
    weight_change VARCHAR(100) COMMENT '体重变化情况',
    disease_condition TEXT COMMENT '疾病状况描述',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
    INDEX idx_health_risk_user (user_id),
    INDEX idx_health_risk_level (risk_level),
    INDEX idx_health_risk_time (assessment_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户健康风险测评记录表';

INSERT INTO user_health_risk_assessment (
    user_id, user_name, sex, age, assessment_time, assessment_count,
    total_score, nutritional_impairment_score, disease_severity_score, age_score,
    assessment_basis, risk_level, bmi, weight_change, disease_condition
) VALUES
-- 1. USER001 历次测评记录（3 次，体现评分由高风险逐步好转）
('USER001', '张建国', '男', 74, DATE_SUB(NOW(), INTERVAL 6 DAY), 1, 6, 3, 2, 1, '近1个月体重下降超5%，合并胃部术后恢复期，年龄>=70岁', '高风险', 17.20, '1个月内下降6.2%', '胃大部切除术后恢复期'),
('USER001', '张建国', '男', 74, DATE_SUB(NOW(), INTERVAL 3 DAY), 2, 4, 2, 1, 1, '肠内营养支持3天后进食改善，年龄>=70岁', '中风险', 17.65, '较上次测评回升0.8kg', '胃大部切除术后恢复期'),
('USER001', '张建国', '男', 74, DATE_SUB(NOW(), INTERVAL 0 DAY), 3, 3, 1, 1, 1, '进食量达目标80%，仍需口服营养补充，年龄>=70岁', '中风险', 18.10, '较首次测评回升1.5kg', '术后康复稳定期'),

-- 2. 高风险患者群体（高龄/低BMI/重症）
('USER002', '王淑芬', '女', 78, DATE_SUB(NOW(), INTERVAL 1 DAY), 2, 7, 3, 3, 1, 'BMI<18.5伴重度吞咽困难及重症肺炎，年龄>=70岁', '高风险', 16.40, '3个月内下降12%', '重症肺炎合并脑卒中后吞咽障碍'),
('USER003', '陈志强', '男', 66, DATE_SUB(NOW(), INTERVAL 2 DAY), 1, 5, 3, 2, 0, '近2个月进食减少75%，血液肿瘤化疗期', '高风险', 17.90, '2个月内下降8.5%', '弥漫大B细胞淋巴瘤化疗期'),
('USER004', '刘秀英', '女', 81, DATE_SUB(NOW(), INTERVAL 1 DAY), 4, 6, 2, 3, 1, 'ICU转入普通病房，白蛋白偏低，年龄>=70岁', '高风险', 18.20, '1个月内下降5.4%', '脓毒症恢复期'),
('USER005', '赵德海', '男', 72, DATE_SUB(NOW(), INTERVAL 4 DAY), 1, 5, 2, 2, 1, '慢性阻塞性肺疾病急性加重，高龄患者', '高风险', 18.00, '3个月内下降7.1%', 'COPD急性加重期'),

-- 3. 中风险患者群体（total_score 3~4 分）
('USER006', '孙丽华', '女', 68, DATE_SUB(NOW(), INTERVAL 2 DAY), 2, 3, 2, 1, 0, '近1周进食量约为正常50%，慢性肾病3期', '中风险', 19.30, '2个月内下降5.1%', '慢性肾脏病CKD 3期'),
('USER007', '周明远', '男', 75, DATE_SUB(NOW(), INTERVAL 5 DAY), 1, 4, 1, 2, 1, '髋关节置换术后卧床，年龄>=70岁', '中风险', 20.40, '近期体重稳定', '股骨颈骨折术后'),
('USER008', '吴桂兰', '女', 71, DATE_SUB(NOW(), INTERVAL 3 DAY), 2, 3, 1, 1, 1, '2型糖尿病伴轻度食欲减退，年龄>=70岁', '中风险', 18.45, '3个月内下降4.0%', '2型糖尿病'),

-- 4. 低风险与无风险群体（total_score 0~2 分）
('USER009', '郑浩然', '男', 52, DATE_SUB(NOW(), INTERVAL 1 DAY), 1, 2, 1, 1, 0, '胆囊结石择期手术前筛查，轻度饮食受限', '低风险', 22.80, '近3个月无明显变化', '胆囊结石伴慢性胆囊炎'),
('USER010', '林晓雯', '女', 45, DATE_SUB(NOW(), INTERVAL 4 DAY), 1, 1, 1, 0, 0, '节食导致轻度体重波动，无基础重症', '低风险', 19.10, '3个月内下降3.2%', '轻度缺铁性贫血'),
('USER011', '黄俊杰', '男', 38, DATE_SUB(NOW(), INTERVAL 5 DAY), 1, 0, 0, 0, 0, '常规住院体检，营养状态良好', '无风险', 23.60, '体重稳定', '常规健康筛查'),
('USER012', '何雅琴', '女', 59, DATE_SUB(NOW(), INTERVAL 6 DAY), 2, 1, 0, 1, 0, '高血压住院调整用药，饮食正常', '无风险', 24.50, '体重稳定', '原发性高血压2级'),
('USER013', '徐国梁', '男', 70, DATE_SUB(NOW(), INTERVAL 0 DAY), 1, 1, 0, 0, 1, '仅年龄达70岁得1分，营养与基础状态良好', '低风险', 23.10, '体重稳定', '老年常规慢病随访');

-- ============================================================================
-- 可选扩展表：用于测试「增加训练（DDL + Document + 跨表 JOIN SQL）」的营养干预表
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_nutrition_intervention (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '干预记录ID',
    user_id VARCHAR(64) NOT NULL COMMENT '关联用户唯一标识',
    assessment_id BIGINT NOT NULL COMMENT '关联测评记录ID',
    intervention_type ENUM('饮食指导', '口服营养补充', '肠内营养', '肠外营养') NOT NULL COMMENT '干预方式',
    daily_target_kcal INT COMMENT '每日目标热量(kcal)',
    follow_up_date DATE COMMENT '复评日期',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户营养干预方案表';

INSERT INTO user_nutrition_intervention (
    user_id, assessment_id, intervention_type, daily_target_kcal, follow_up_date
) VALUES
('USER001', 1, '肠内营养', 1800, DATE_ADD(CURDATE(), INTERVAL 3 DAY)),
('USER001', 3, '口服营养补充', 1900, DATE_ADD(CURDATE(), INTERVAL 7 DAY)),
('USER002', 4, '肠内营养', 1600, DATE_ADD(CURDATE(), INTERVAL 2 DAY)),
('USER003', 5, '肠外营养', 2000, DATE_ADD(CURDATE(), INTERVAL 3 DAY)),
('USER004', 6, '肠内营养', 1750, DATE_ADD(CURDATE(), INTERVAL 5 DAY)),
('USER006', 8, '饮食指导', 1650, DATE_ADD(CURDATE(), INTERVAL 14 DAY));
