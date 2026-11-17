"""Private candidate codec, selected only with the independently accepted DDL.
Neither the source repo nor generic commerce/cart models are modified.
"""
from sqlalchemy import Enum, text
from benefit_source import BenefitReview

COMPLEMENTARY_TYPES = ('REGULAR','JIT','PRE_ORDER','MTO','FREEBIE')


def install_complementary_codec(session, model, contract):
    if contract != 'pos-csv-pos-complementary-v1': raise BenefitReview()
    columns = session.execute(text("SELECT COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='has_products' AND COLUMN_NAME='type'")).mappings().all()
    expected = "enum('REGULAR','JIT','PRE_ORDER','MTO','FREEBIE')"
    if len(columns) != 1 or columns[0]['COLUMN_TYPE'] != expected or columns[0]['IS_NULLABLE'] != 'YES' or columns[0]['COLUMN_DEFAULT'] is not None:
        raise BenefitReview('ORDER_IMPORT_FREEBIE_SCHEMA_UNQUALIFIED')
    old = tuple(model.__table__.c.type.type.enums)
    if old not in (COMPLEMENTARY_TYPES[:-1], COMPLEMENTARY_TYPES):
        raise BenefitReview('ORDER_IMPORT_FREEBIE_SCHEMA_UNQUALIFIED')
    model.__table__.c.type.type = Enum(*COMPLEMENTARY_TYPES, validate_strings=True)
