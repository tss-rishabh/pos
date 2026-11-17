"""Reviewable additive source caller/bootstrap hooks. Never edits a sibling.

Root's common/public generators call these functions with their composed
candidate bytes; unrelated source/refund/membership patches are retained.
"""
from pathlib import Path
import hashlib

API_COMMIT='2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
LEGACY_COMMIT='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'


def once(value,old,new):
    if value.count(old)!=1:raise RuntimeError('Screening origin source boundary changed')
    return value.replace(old,new,1)


def api_changes(changes):
    changes=dict(changes)
    original,main=changes['main.py']
    main=once(main,'from pos_node_screening import install',
        'from pos_screening_origins import prepare as _prepare_origins\n_prepare_origins(__file__)\nfrom pos_node_screening import install')
    main=once(main,'_node_screening.activate(vars(OrderController))',
        '_node_screening.activate(vars(OrderController))\nfrom pos_screening_origins import install as _install_origins\n_screening_origins = _install_origins().activate(_node_screening, vars(OrderController))')
    main=once(main,'middleware = [_node_screening, DatabaseManager(',
        'middleware = [_node_screening, _screening_origins, DatabaseManager(')
    marker="app.add_route(settings.API_PREFIX + '/order', OrderController.Order())"
    main=once(main,marker,'_screening_origins.register(app, settings)\n'+marker)
    # Mount the qualified WSGI resource only after all actual source routes.
    # The existing Falcon app remains the fallback and original source server.
    main+='\nimport sys as _origin_event_stream\napp = _screening_origins.coupon_control_application(app, _origin_event_stream.stdout)\n'
    changes['main.py']=(original,main)
    entry='''"""Purpose-specific original customer/staff/system writer installation."""\nimport os\nimport sys\nfrom pathlib import Path\n_root=Path(os.environ['POS_NODE_SCREENING_MODULE_ROOT']).resolve()\nfor name in ('legacy-order-imports','offline-cash-pricing','public-screening-writer','screening-origins'):sys.path.insert(0,str(_root/name))\ndef prepare(main_file):\n    if not os.environ.get('POS_SCREENING_ORIGIN_CONTRACT'):return\n    from origin_delivery import prepare as early\n    early(main_file)\ndef install():\n    from origin_bootstrap import OriginBootstrap\n    return OriginBootstrap()\n'''
    changes['pos_screening_origins.py']=('',entry)
    return changes


def legacy_changes(root):
    root=Path(root)
    changes={}
    path='order/views.py';original=(root/path).read_text();value=original
    before,body=value.split('class AjaxOrderView(',1)
    view,after=body.split('class AjaxOrderCancelView(',1)
    method_start=view.index('    def order(');method_end=view.index('    def orders(',method_start)
    prefix=view[:method_start];method=view[method_start:method_end];remaining=view[method_end:]
    old='        return requests.post(url, json=payload, headers=headers)'
    new='''        from pos_screening_origin_legacy import order_headers as screening_headers, original_response as screening_response, command_created
        prepared = screening_headers(self.request, auth_token, payload, url)
        if prepared and prepared.get('recovered'):
            command_created(prepared['commandId'], prepared['recovered']['order'])
            return screening_response(prepared['recovered'])
        if prepared:
            headers.update(prepared['headers'])
        else:
            return requests.post(url, json=payload, headers=headers)
        result = requests.post(url, json=payload, headers=headers, timeout=(5, 30), allow_redirects=False)
        if prepared and result.status_code == 200:
            command_created(prepared['commandId'], result.json()['order'])
        return result'''
    method=once(method,old,new)
    remaining=once(remaining,old,'''        from pos_screening_origin_legacy import payment as screening_payment
        return screening_payment(self.request, auth_token, payload, url)''')
    value=before+'class AjaxOrderView('+prefix+method+remaining+'class AjaxOrderCancelView('+after
    value+='\nfrom pos_screening_origin_legacy import install as _install_screening_origins\n_install_screening_origins(globals())\n'
    value=value.replace('"show_customer_insights": _customer_insights_enabled(store_id),',
        '"show_customer_insights": _customer_insights_enabled(store_id),\n            "screening_origin_enabled": __import__("pos_screening_origin_legacy").selected(),')
    changes[path]=(original,value)
    path='users/views.py';original=(root/path).read_text();value=original
    before,body=value.split('class MPosLogin(View):',1);login,after=body.split('class AuthQRGen(',1)
    login=once(login,'        auth_check = False','        auth_check = False\n        authenticated_user = None')
    login=once(login,'                auth_check = self.mpos_check_otp(user.id, pos_otp)',
        '                auth_check = self.mpos_check_otp(user.id, pos_otp)\n                if auth_check:\n                    authenticated_user = user')
    login=once(login,'                    auth_check = self.mpos_check_otp(user_obj.id, pos_otp)',
        '                    auth_check = self.mpos_check_otp(user_obj.id, pos_otp)\n                    if auth_check:\n                        authenticated_user = user_obj')
    login=once(login,'                auth_check = authenticate(username=email, password=password)',
        '                auth_check = authenticate(username=email, password=password)\n                if auth_check:\n                    authenticated_user = auth_check')
    success='''            return HttpResponse(
                json.dumps({"status": "success", "message": str(email), "is_authenticated": True}),
                content_type='application/json'
            )'''
    replacement='''            response = HttpResponse(
                json.dumps({"status": "success", "message": str(email), "is_authenticated": True}),
                content_type='application/json'
            )
            from pos_screening_origin_legacy import authenticated_mpos
            return authenticated_mpos(request, response, authenticated_user)'''
    login=once(login,success,replacement)
    value=before+'class MPosLogin(View):'+login+'class AuthQRGen('+after
    value=once(value,'        if user_id:\n            list_keys = redis_instance.keys(',
        '        if user_id:\n            from pos_screening_origin_legacy import revoke\n            revoke(user_id)\n            list_keys = redis_instance.keys(')
    changes[path]=(original,value)
    path='helpers/helpers.py';original=(root/path).read_text()
    value=once(original,'        value = [check_in_store, store_name]\n        key = f"check_in_{user_id}"',
        '        from pos_screening_origin_legacy import revoke\n        revoke(user_id)\n        value = [check_in_store, store_name]\n        key = f"check_in_{user_id}"')
    changes[path]=(original,value)
    entry='''"""Selected-only original legacy authority/nonce hooks."""\nimport os\nimport sys\nfrom pathlib import Path\ndef selected():return os.environ.get('POS_SCREENING_ORIGIN_CONTRACT')=='pos-screening-origins-v1'\ndef modules():\n    root=Path(os.environ['POS_NODE_SCREENING_MODULE_ROOT']).resolve()\n    for name in ('public-screening-writer','screening-origins'):sys.path.insert(0,str(root/name))\ndef install(namespace):\n    if selected():\n        modules()\n        from legacy_execution import install as apply\n        apply(namespace)\ndef authenticated_mpos(request,response,user):\n    if not selected():return response\n    modules()\n    from legacy_staff import after_mpos_authentication\n    return after_mpos_authentication(request,response,user)\ndef revoke(actor_id):\n    if selected():\n        modules()\n        from legacy_staff import revoke_actor\n        revoke_actor(actor_id)\ndef order_headers(*args,**kwargs):\n    if not selected():return {}\n    modules()\n    from legacy_client import headers\n    return headers(*args,**kwargs)\ndef original_response(*args,**kwargs):\n    modules()\n    from legacy_client import response\n    return response(*args,**kwargs)\ndef command_created(*args):\n    if selected():\n        modules()\n        from legacy_execution import command_created as created\n        return created(*args)\ndef payment(request,token,body,url):\n    if not selected():\n        import requests\n        return requests.post(url,json=body,headers={'Content-Type':'application/json','Authorization':token})\n    modules()\n    from legacy_client import payment as submit\n    return submit(request,token,body,url)\n'''
    changes['pos_screening_origin_legacy.py']=('',entry)
    path='order/urls.py';original=(root/path).read_text()
    value=original+'\nfrom pos_screening_origin_legacy import selected as _screening_origins_selected\nif _screening_origins_selected():\n    from pos_screening_origin_legacy import modules as _screening_origin_modules\n    _screening_origin_modules()\n    from legacy_resources import urls as _screening_origin_urls\n    urlpatterns += _screening_origin_urls()\n'
    changes[path]=(original,value)
    path='order/templates/order/create_order.html';original=(root/path).read_text()
    mount='''{% if screening_origin_enabled %}
<script type="module">
import {installLegacyScreeningNonce} from "{% static 'pos-screening-origins/legacy-nonce.mjs' %}";
let controller;
const panel=document.createElement('aside');panel.hidden=true;panel.setAttribute('role','status');
const text=document.createElement('span'),check=document.createElement('button'),done=document.createElement('button');
check.type='button';check.textContent='Check screening command';done.type='button';done.textContent='Acknowledge completed command';
panel.append(text,check,done);document.body.prepend(panel);
function display(value){panel.hidden=false;text.textContent='Screening command '+String(value.commandId||'')+': '+String(value.state||'verification required')+' ';done.hidden=!['complete','cash-completed'].includes(value.state);}
controller=installLegacyScreeningNonce({jquery:window.jQuery,
 currentScope:()=>({actorId:'{{ request.user.id|escapejs }}',storeId:'{{ store_id|escapejs }}',counterId:'{{ counter_id|escapejs }}',tabId:'{{ tab_id|escapejs }}'}),
 containsScreening:()=>!!document.getElementById('tr-product-390238'),
 recoveryPath:(id)=>"{% url 'screening-command-recovery' '00000000-0000-0000-0000-000000000000' %}".replace('00000000-0000-0000-0000-000000000000',id),showRecovery:display});
controller.registerPaths(["{% url 'ajax-order' %}","{% url 'ajax-fast-checkout' %}"]);
check.addEventListener('click',()=>controller.recover().catch(()=>display({state:'verification required'})));
done.addEventListener('click',()=>{controller.acknowledgeComplete();panel.hidden=true;});
</script>
{% endif %}
'''
    value=once(original,'{% endblock custom-script %}',mount+'{% endblock custom-script %}')
    changes[path]=(original,value)
    changes['static/pos-screening-origins/legacy-nonce.mjs']=('',(Path(__file__).parent/'legacy-nonce.mjs').read_text())
    return changes


def manifest(changes):
    return {'contract':'pos-screening-origins-v1','activated':False,'apiCommit':API_COMMIT,'legacyCommit':LEGACY_COMMIT,
            'candidate':{name:hashlib.sha256(new.encode()).hexdigest() for name,(_old,new) in changes.items()}}
