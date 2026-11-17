"""Emit/check review-only trigger definitions. Never connect or execute DDL."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
CONTRACT='pos-membership-history-head-v1'
TABLE='pos_rewrite_membership_history_heads'


def bump(customer):
    return f'INSERT INTO {TABLE}(customer_id,revision) VALUES({customer},1) ON DUPLICATE KEY UPDATE revision=revision+1;'


def both():
    return f'''IF a IS NOT NULL AND b IS NOT NULL AND a<>b THEN
 IF a<b THEN {bump('a')} {bump('b')} ELSE {bump('b')} {bump('a')} END IF;
ELSEIF a IS NOT NULL THEN {bump('a')}
ELSEIF b IS NOT NULL THEN {bump('b')} END IF;'''


def statements():
    values=[]
    def add(suffix,table,event,body):
        name='pos_rewrite_member_history_'+suffix
        values.append({'name':name,'tableName':table,'event':event,'timing':'AFTER','body':body})
    add('order_i','orders','INSERT',f'BEGIN IF NEW.order_status=3 THEN {bump("NEW.user_id")} END IF; END')
    add('order_d','orders','DELETE',f'BEGIN IF OLD.order_status=3 THEN {bump("OLD.user_id")} END IF; END')
    add('order_u','orders','UPDATE',f'''BEGIN DECLARE a BIGINT DEFAULT NULL; DECLARE b BIGINT DEFAULT NULL;
IF OLD.order_status=3 THEN SET a=OLD.user_id; END IF;
IF NEW.order_status=3 THEN SET b=NEW.user_id; END IF;
{both()} END''')
    add('hp_i','has_products','INSERT',f'''BEGIN DECLARE a BIGINT DEFAULT NULL;
SELECT user_id INTO a FROM orders WHERE id=NEW.order_id AND order_status=3 FOR SHARE;
IF a IS NOT NULL THEN {bump('a')} END IF; END''')
    add('hp_d','has_products','DELETE',f'''BEGIN DECLARE a BIGINT DEFAULT NULL;
SELECT user_id INTO a FROM orders WHERE id=OLD.order_id AND order_status=3 FOR SHARE;
IF a IS NOT NULL THEN {bump('a')} END IF; END''')
    add('hp_u','has_products','UPDATE',f'''BEGIN DECLARE a BIGINT DEFAULT NULL; DECLARE b BIGINT DEFAULT NULL;
SELECT user_id INTO a FROM orders WHERE id=OLD.order_id AND order_status=3 FOR SHARE;
SELECT user_id INTO b FROM orders WHERE id=NEW.order_id AND order_status=3 FOR SHARE;
{both()} END''')
    add('user_i','users','INSERT',f'BEGIN INSERT INTO {TABLE}(customer_id,revision) VALUES(NEW.id,0) ON DUPLICATE KEY UPDATE customer_id=customer_id; END')
    return values


def outputs():
    values=statements()
    definitions=[{**{name:item[name] for name in ('name','tableName','event','timing')},
                  'hash':hashlib.sha256(item['body'].encode()).hexdigest()} for item in values]
    digest=hashlib.sha256(json.dumps(definitions,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    sql='''-- REVIEW ONLY. Qualify all source writers and the exact operational writer origin.
-- Install under a coordinated writer cutover. Runtime never applies this DDL.
CREATE TABLE IF NOT EXISTS pos_rewrite_membership_history_heads (
 customer_id BIGINT NOT NULL PRIMARY KEY,
 revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB;
-- Backfill all existing identities before publishing any complete generation.
-- New identities and every delivered-history mutation are tracked by triggers.
INSERT INTO pos_rewrite_membership_history_heads(customer_id,revision)
SELECT id,0 FROM users ON DUPLICATE KEY UPDATE customer_id=customer_id;
'''
    for item in values:
        sql+=f"\nDELIMITER $$\nCREATE TRIGGER {item['name']} {item['timing']} {item['event']} ON {item['tableName']} FOR EACH ROW\n{item['body']}$$\nDELIMITER ;\n"
    return {'membership-history-writers.review.json':json.dumps({'contract':CONTRACT,'definitions':definitions,'writersHash':digest},indent=2)+'\n',
            'membership-history-writers.review.sql':sql,
            str(ROOT.parents[2]/'src/modules/checkout/screening-writer/membership-history-writers.ts'):
                '// Generated from the review-only membership-history trigger definitions.\nexport const membershipHistoryWriters = '+json.dumps({'contract':CONTRACT,'definitions':definitions,'writersHash':digest},indent=2)+' as const;\n'}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');args=parser.parse_args()
    for name,value in outputs().items():
        target=ROOT/name
        if args.write:target.write_text(value)
        elif not target.exists() or target.read_text()!=value:raise RuntimeError('Membership writer review artifact changed')
