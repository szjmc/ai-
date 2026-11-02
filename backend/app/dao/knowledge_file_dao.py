from datetime import datetime

from app.models.mysql.knowledge_file import KnowledgeFile
class KnowledgeFileDAO:
    def __init__(self, db_manager):
        self.db_manager = db_manager

    def create_file(self, file_data):
        """创建新文件记录"""
        session = self.db_manager.get_session()
        try:
            new_file = KnowledgeFile(**file_data)
            session.add(new_file)
            session.commit()
            session.refresh(new_file)
            # 在session关闭前获取id
            # 如果需要，可以将对象从session中分离，以免后续访问属性出错
            session.expunge(new_file)
            return new_file
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    def get_file_by_id(self, file_id):
        """根据ID获取文件"""
        session = self.db_manager.get_session()
        try:
            return session.query(KnowledgeFile).filter_by(id=file_id).first()
        finally:
            session.close()

    def update_file(self, file_id, update_data):
        """更新文件信息"""
        session = self.db_manager.get_session()
        try:
            file = session.query(KnowledgeFile).filter_by(id=file_id).first()
            if file:
                for key, value in update_data.items():
                    if hasattr(file, key):
                        setattr(file, key, value)
                file.updated_time = datetime.now()
                session.commit()
                return file
            return None
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    def delete_file(self, file_id):
        """删除文件记录"""
        session = self.db_manager.get_session()
        try:
            file = session.query(KnowledgeFile).filter_by(id=file_id).first()
            if file:
                session.delete(file)
                session.commit()
                return True
            return False
        except Exception as e:
            session.rollback()
            raise e
        finally:
            session.close()

    def list_files(self, filters=None, page=1, per_page=20):
        """列出文件，支持过滤和分页"""
        session = self.db_manager.get_session()
        try:
            query = session.query(KnowledgeFile)

            if filters:
                for key, value in filters.items():
                    if hasattr(KnowledgeFile, key):
                        query = query.filter(getattr(KnowledgeFile, key) == value)

            total = query.count()
            items = query.order_by(
                KnowledgeFile.created_time.desc()
            ).offset((page - 1) * per_page).limit(per_page).all()

            return {
                "items": items,
                "total": total,
                "page": page,
                "per_page": per_page,
                "pages": (total + per_page - 1) // per_page
            }
        finally:
            session.close()