"""Explicit private ORM codec correction; no legacy DDL or row backfill.

The pinned Shopify helper supplies two physically existing but unmapped fields.
Two other source defaults are integers for native ENUM string labels and fail
strict MySQL. Preserve the actual physical labels/defaults in this process.
"""
from sqlalchemy import Column,String,Enum,Float,text
from protocol import ImportReview

CONTRACT='pos-import-source-model-v1'
EXPECTED={
 'currency':('varchar(55)','NO','INR'),
 'currency_conv_rate':('varchar(45)','NO','0'),
 'reward_points_cron':("enum('0','1','2','3')",'NO','2'),
 'ship_flag':("enum('0','1')",'NO','0'),
}
ADDITIONAL={
 'order_stores':{'transaction_id':('varchar(255)','NO',None),'message':('varchar(255)','NO',None)},
 'has_products':{'return_qty':('varchar(10)','NO',None),'return_reason':('varchar(500)','NO',None),
                 'vinc_status':('varchar(55)','NO',None),'hp_cart_additional_discount':('float','NO',None)},
}


def verify_physical_columns(connection):
    values=connection.execute(text("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME IN ('currency','currency_conv_rate','reward_points_cron','ship_flag')")).mappings().all()
    if len(values)!=4 or {row['COLUMN_NAME']:(row['COLUMN_TYPE'],row['IS_NULLABLE'],row['COLUMN_DEFAULT']) for row in values}!=EXPECTED:
        error=ImportReview('ORDER_IMPORT_SOURCE_MODEL_UNQUALIFIED')
        error.metadata=[dict(row) for row in values]
        raise error
    for table,expected in ADDITIONAL.items():
        values=connection.execute(text('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=:table'),{'table':table}).mappings().all()
        actual={row['COLUMN_NAME']:(row['COLUMN_TYPE'],row['IS_NULLABLE'],row['COLUMN_DEFAULT']) for row in values if row['COLUMN_NAME'] in expected}
        if actual!=expected:
            raise ImportReview('ORDER_IMPORT_SOURCE_MODEL_UNQUALIFIED')


def install_model_codec(model,store=None,line=None):
    if 'currency' not in model.__table__.c:
        model.currency=Column(String(55),nullable=False,server_default=text("'INR'"))
    if 'currency_conv_rate' not in model.__table__.c:
        model.currency_conv_rate=Column(String(45),nullable=False,server_default=text("'0'"))
    for name,labels in [('reward_points_cron',('0','1','2','3')),('ship_flag',('0','1'))]:
        column=model.__table__.c[name]
        if column.default is None or not column.default.is_scalar or column.default.arg not in (0,'0'):
            raise ImportReview('ORDER_IMPORT_SOURCE_MODEL_UNQUALIFIED')
        column.type=Enum(*labels)
        column.default.arg='0'
    if store is not None:
        for name in ('transaction_id','message'):
            if name not in store.__table__.c:
                setattr(store,name,Column(String(255),nullable=False,default=''))
    if line is not None:
        for name,length in [('return_qty',10),('return_reason',500),('vinc_status',55)]:
            if name not in line.__table__.c:
                setattr(line,name,Column(String(length),nullable=False,default=''))
        if 'hp_cart_additional_discount' not in line.__table__.c:
            line.hp_cart_additional_discount=Column(Float,nullable=False,default=0)
