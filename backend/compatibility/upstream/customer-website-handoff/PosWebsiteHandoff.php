<?php
/** Additive Laravel 4/PHP 5.6 receiver candidate; not an existing/deployed website route.
 * All failures are static. No request/receipt/customer data is logged here.
 */
class PosWebsiteHandoff {
    const CONTRACT = 'pos-customer-website-handoff-v1';

    public static function unavailable() { throw new RuntimeException('CUSTOMER_WEBSITE_HANDOFF_UNAVAILABLE'); }
    public static function opaque($value) { return is_string($value) && preg_match('/\A[A-Za-z0-9_-]{43}\z/D', $value); }
    public static function uuid($value) {
        return is_string($value) && preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/Di', $value);
    }
    public static function randomToken() {
        $bytes = openssl_random_pseudo_bytes(32, $strong);
        if (!$strong || $bytes === false) self::unavailable();
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }
    public static function operationId() {
        $bytes = openssl_random_pseudo_bytes(16, $strong);
        if (!$strong || $bytes === false) self::unavailable();
        $bytes[6] = chr((ord($bytes[6]) & 15) | 64);
        $bytes[8] = chr((ord($bytes[8]) & 63) | 128);
        $hex = bin2hex($bytes);
        return substr($hex,0,8).'-'.substr($hex,8,4).'-'.substr($hex,12,4).'-'.substr($hex,16,4).'-'.substr($hex,20);
    }
    private static function origin($url, $path) {
        $parts = is_string($url) ? parse_url($url) : false;
        if (!$parts || !isset($parts['scheme'],$parts['host'],$parts['path']) ||
            $parts['scheme'] !== 'https' || $parts['path'] !== $path ||
            isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) self::unavailable();
        return 'https://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');
    }
    public static function configuration($raw) {
        if (!is_array($raw) || !isset($raw['contract'],$raw['receiver_url'],$raw['redemption_url'],$raw['service_key'],$raw['customer_connection']) ||
            $raw['contract'] !== self::CONTRACT || !is_string($raw['service_key']) ||
            !is_string($raw['customer_connection']) || !preg_match('/\A[A-Za-z0-9_-]{1,64}\z/D',$raw['customer_connection']) ||
            !preg_match('/\A[!-~]{32,4096}\z/D', $raw['service_key'])) self::unavailable();
        return array('origin'=>self::origin($raw['receiver_url'],'/pos/secure-login'),
            'redemptionUrl'=>$raw['redemption_url'],
            'apiOrigin'=>self::origin($raw['redemption_url'],'/api/v1/auth/customer-website-handoffs/redemptions'),
            'key'=>$raw['service_key'],'customerConnection'=>$raw['customer_connection']);
    }
    public static function input($body, $csrf) {
        if (!is_array($body) || count($body)!==3 || !isset($body['token'],$body['operationId'],$body['_token']) ||
            !self::opaque($body['token']) || !self::uuid($body['operationId']) ||
            !is_string($body['_token']) || !is_string($csrf) || !preg_match('/\A[A-Za-z0-9_-]{32,128}\z/D',$csrf) ||
            !hash_equals($csrf,$body['_token'])) self::unavailable();
        return array('token'=>$body['token'],'operationId'=>$body['operationId']);
    }
    public static function receipt($value, $operationId, $now) {
        $keys=array('contract','receiptId','operationId','checkoutId','checkoutVersion','customerId','operatorId','operatorCustomerId','storeId','counterId','sessionExpiresAt');
        if (!is_array($value) || count($value)!==count($keys) || array_diff($keys,array_keys($value)) ||
            $value['contract']!==self::CONTRACT || $value['operationId']!==$operationId ||
            !self::uuid($value['receiptId']) || !self::uuid($value['operationId']) || !self::uuid($value['checkoutId']) ||
            !is_int($value['checkoutVersion']) || $value['checkoutVersion']<0 ||
            !is_int($value['sessionExpiresAt']) || $value['sessionExpiresAt']<=$now || $value['sessionExpiresAt']>$now+900000)
            self::unavailable();
        foreach(array('customerId','operatorId','operatorCustomerId','storeId','counterId') as $key)
            if(!is_string($value[$key]) || !preg_match('/\A[1-9][0-9]{0,18}\z/D',$value[$key]) ||
               strlen($value[$key])===19 && strcmp($value[$key],'9223372036854775807')>0) self::unavailable();
        return $value;
    }
    /** Machine request; HTTPS only, no redirect/cookie/JWT, bounded bytes and fixed timeouts. */
    public static function redeem($configuration, $input, $browserBinding) {
        if (!self::opaque($browserBinding)) self::unavailable();
        $curl = curl_init($configuration['redemptionUrl']);
        $body = ''; $overflow = false;
        curl_setopt_array($curl,array(
            CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode(array(
                'operationId'=>$input['operationId'],'token'=>$input['token'],'browserBinding'=>$browserBinding)),
            CURLOPT_HTTPHEADER=>array('Content-Type: application/json','Accept: application/json',
                'Origin: '.$configuration['origin'],'X-Customer-Website-Handoff-Key: '.$configuration['key']),
            CURLOPT_FOLLOWLOCATION=>false,CURLOPT_MAXREDIRS=>0,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
            CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_CONNECTTIMEOUT=>2,CURLOPT_TIMEOUT=>8,
            CURLOPT_VERBOSE=>false,CURLOPT_PROXY=>'',
            CURLOPT_WRITEFUNCTION=>function($handle,$bytes) use (&$body,&$overflow) {
                if(strlen($body)+strlen($bytes)>32768) {$overflow=true;return 0;}
                $body.=$bytes;return strlen($bytes);
            }
        ));
        $ok=curl_exec($curl);
        $status=curl_getinfo($curl,CURLINFO_HTTP_CODE);
        $type=curl_getinfo($curl,CURLINFO_CONTENT_TYPE);
        curl_close($curl);
        if($ok===false || $overflow || $status!==200 || !is_string($type) || stripos($type,'application/json')!==0) self::unavailable();
        return self::receipt(json_decode($body,true),$input['operationId'],(int)floor(microtime(true)*1000));
    }
    public static function activeCustomer($customer, $customerId) {
        return $customer && (string)$customer->id===$customerId && (string)$customer->user_type==='2' &&
            (int)$customer->status===1 && (int)$customer->is_block!==1 && (int)$customer->is_disabled!==1;
    }
    /** No name/contact/balance/JWT is copied into the browser or the new server receipt state. */
    public static function establish($receipt, $customer, $binding) {
        if (!self::activeCustomer($customer,$receipt['customerId']) || !self::opaque($binding)) self::unavailable();
        $csrf=Session::token();
        if(!is_string($csrf)||!preg_match('/\A[A-Za-z0-9_-]{32,128}\z/D',$csrf))self::unavailable();
        Auth::logout();
        Session::flush();
        // Keep the old PREAUTH session usable for an exact lost-cookie retry; it
        // receives no new login. New auth always uses a regenerated session ID.
        Session::regenerate(false);
        Session::put('_token',$csrf);
        Auth::login($customer,false);
        Session::put('loggedin_user_id',$receipt['customerId']);
        Session::put('login_user_type','2');
        Session::put('pos_store_id',$receipt['storeId']);
        Session::put('pos_user_id',$receipt['operatorCustomerId']);
        Session::put('pos_operator_id',$receipt['operatorId']);
        Session::put('pos_handoff_receipt_id',$receipt['receiptId']);
        Session::put('pos_handoff_expires_at',$receipt['sessionExpiresAt']);
        Session::put('pos_handoff_receiver_binding',$binding);
    }
    public static function expireIfRequired($now) {
        if (!Session::has('pos_handoff_expires_at')) return;
        $customer=Auth::user();
        if (!is_int(Session::get('pos_handoff_expires_at')) || Session::get('pos_handoff_expires_at')<=$now ||
            !self::activeCustomer($customer,(string)Session::get('loggedin_user_id'))) {
            Auth::logout();Session::flush();Session::regenerate(true);
            Session::put('_token',self::randomToken());
        }
    }
}
