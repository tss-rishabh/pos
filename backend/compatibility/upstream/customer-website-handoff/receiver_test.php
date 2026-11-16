<?php
// Actual isolated PHP 5.6 execution, no Laravel boot, network, DB or source changes.
require __DIR__.'/PosWebsiteHandoff.php';
class Session {
    public static $values=array(); public static $rotations=0;
    public static function flush(){self::$values=array();}
    public static function regenerate($destroy=false){self::$rotations++;self::$values['_token']='regenerated-token-is-replaced';}
    public static function put($key,$value){self::$values[$key]=$value;}
    public static function token(){return self::get('_token');}
    public static function get($key){return isset(self::$values[$key])?self::$values[$key]:null;}
    public static function has($key){return array_key_exists($key,self::$values);}
}
class Auth {
    public static $customer=null;public static $logins=0;
    public static function logout(){self::$customer=null;}
    public static function login($customer,$remember=false){if($remember)throw new Exception('Remember forbidden');self::$customer=$customer;self::$logins++;}
    public static function user(){return self::$customer;}
}
$checks=0;
function check($value){global $checks;$checks++;if(!$value)throw new RuntimeException('Synthetic receiver assertion failed.');}
function rejects($action){try{$action();}catch(RuntimeException $e){check($e->getMessage()==='CUSTOMER_WEBSITE_HANDOFF_UNAVAILABLE');return;}throw new RuntimeException('Expected static rejection.');}
$now=1700000000000;
$op='4918d168-c62e-4ed7-b8ae-89b0a5e70019';
$receipt=array('contract'=>PosWebsiteHandoff::CONTRACT,'receiptId'=>'4918d168-c62e-4ed7-b8ae-89b0a5e70010',
    'operationId'=>$op,'checkoutId'=>'4918d168-c62e-4ed7-b8ae-89b0a5e70012','checkoutVersion'=>3,
    'customerId'=>'9007199254740993','operatorId'=>'1','operatorCustomerId'=>'88','storeId'=>'1','counterId'=>'1','sessionExpiresAt'=>$now+300000);
$csrf=str_repeat('c',40);$binding=str_repeat('b',43);
$customer=(object)array('id'=>'9007199254740993','user_type'=>'2','status'=>1,'is_block'=>0,'is_disabled'=>0,'email'=>'never-copied@example.test');
$config=array('contract'=>PosWebsiteHandoff::CONTRACT,'receiver_url'=>'https://website.fixture.test/pos/secure-login',
    'redemption_url'=>'https://pos.fixture.test/api/v1/auth/customer-website-handoffs/redemptions','service_key'=>str_repeat('k',43),'customer_connection'=>'writer');
check(PosWebsiteHandoff::configuration($config)['origin']==='https://website.fixture.test');
foreach(array('http://website.fixture.test/pos/secure-login','https://website.fixture.test/pos/secure-login?token=x','https://user:password@website.fixture.test/pos/secure-login','https://website.fixture.test/other') as $url){
    $bad=$config;$bad['receiver_url']=$url;rejects(function()use($bad){PosWebsiteHandoff::configuration($bad);});
}
check(PosWebsiteHandoff::input(array('token'=>str_repeat('a',43),'operationId'=>$op,'_token'=>$csrf),$csrf)['operationId']===$op);
rejects(function()use($op,$csrf){PosWebsiteHandoff::input(array('token'=>str_repeat('a',43),'operationId'=>$op,'_token'=>'bad'),$csrf);});
check(PosWebsiteHandoff::receipt($receipt,$op,$now)===$receipt);
foreach(array('customerId'=>9007199254740993,'sessionExpiresAt'=>$now+900001,'orderId'=>'unapproved') as $key=>$value){
    $bad=$receipt;$bad[$key]=$value;rejects(function()use($bad,$op,$now){PosWebsiteHandoff::receipt($bad,$op,$now);});
}
Session::$values=array('_token'=>$csrf,'previous_customer'=>'must-clear','cart'=>array('old-account-item'));
PosWebsiteHandoff::establish($receipt,$customer,$binding);
check(Auth::$customer===$customer && Auth::$logins===1 && Session::$rotations===1);
check(Session::get('pos_user_id')==='88' && Session::get('pos_operator_id')==='1');
check(!Session::has('previous_customer')&&!Session::has('cart'));
check(Session::get('loggedin_user_id')==='9007199254740993' && Session::token()===$csrf);
check(strpos(json_encode(Session::$values),'never-copied')===false);
// Exact lost-response retry retains the same receiver binding + CSRF, never a JWT or cap.
check(Session::get('pos_handoff_receiver_binding')===$binding);
PosWebsiteHandoff::establish($receipt,$customer,$binding);
check(Session::get('pos_handoff_expires_at')===$receipt['sessionExpiresAt']);
PosWebsiteHandoff::expireIfRequired($now+299999);check(Auth::$customer===$customer);
PosWebsiteHandoff::expireIfRequired($now+300000);check(Auth::$customer===null && !Session::has('pos_user_id'));
$blocked=clone $customer;$blocked->is_block=1;
rejects(function()use($receipt,$blocked,$binding){PosWebsiteHandoff::establish($receipt,$blocked,$binding);});
check(PosWebsiteHandoff::opaque(PosWebsiteHandoff::randomToken()));
check(PosWebsiteHandoff::uuid(PosWebsiteHandoff::operationId()));
echo json_encode(array('checks'=>$checks,'php'=>PHP_VERSION,'network'=>false,'passed'=>true)),"\n";
