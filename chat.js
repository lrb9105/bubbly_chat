/** ssl 적용 */
const fs = require("fs");
const http = require("http");
const https = require("https");

const privateKey = fs.readFileSync('/etc/letsencrypt/live/bubbly-chat.tk/privkey.pem');
const certificate = fs.readFileSync('/etc/letsencrypt/live/bubbly-chat.tk/cert.pem');
const ca = fs.readFileSync('/etc/letsencrypt/live/bubbly-chat.tk/chain.pem');

const options = {
  key: privateKey,
  cert: certificate,
  ca: ca,
};

/** firebase admin sdk */
const admin = require("firebase-admin");
const serviceAccountJson = require("./fcm_account/serviceAccountKey.json");

// mariaDB를 연결하기 위해 모듈 가져옴
const maria = require('./db/maria');

/* express */
const express = require('express')
const app = express();
const port2 = 3000;

const config = require("./config/config");

/** 세개 다 공통 start */

// 요청 값을 저장하기 위한 해시맵
const HashMap  = require ('hashmap') ;

// hashmap은 여러 함수에서 사용할 것이므로 인스턴스 변수로 생성
let hashmap;

// busboy
const busboy = require('connect-busboy');

// 시간 
const time = require('./util/time');

/** 세개 다 공통 end*/

/** chat.js start */
// 채팅 구분값
const chatDivisionVal = "@@@@@";

// 클라우드 프론트 주소
const cloudFrontAddr = config.cloudfront;

// 채팅방의 전체 참여자와 현재참여자수를 저장하는 맵
let userCountMap = new Map();

// 채팅방에 참여하고 있는 사용자들의 아이디리스트를 저장하는 맵
let currentChatUserIdListap = new Map();

let bubbly_chat;
/** chat.js end */

/** mqtt */
const Aedes = require('aedes')
const mongoPersistence = require('aedes-persistence-mongodb')
const portMqtt = config.portMqtt

/** mqtt start */
const db = mongoPersistence({
  url: config.mongoPersistenceUrl, 
  mongoOptions: { 
    auth: {
      username: config.mongoDbId,
      password: config.mongoDbPw
    }
  },
  ttl: {
      packets: {
        incoming: 300,
        outgoing: 300,
        will: 300,
        retained: 0
      },
      subscriptions: 0,
  }
});

// mongodb
const mongodb = require('mongodb');
const MongoClient = mongodb.MongoClient;
//const Binary = mongodb.Binary;
const url = config.mongoDbUrl;
const aedes = Aedes({persistence: db});
const server = require('net').createServer(aedes.handle)
/** mqtt end */

// 사용자수 관리 맵 초기화
initUserCountMap();

// firebase-admin 초기화
admin.initializeApp({
  //credential: admin.credential.applicationDefault
  credential : admin.credential.cert(serviceAccountJson)
});

// 사용자가 구독요청한 경우
aedes.on('subscribe', function (subscriptions, client) {
  console.log('MQTT client: ' + client.id + " subscribe topic: " + subscriptions.map(s => s.topic).join('\n'));
 });

 // 사용자가 구독요청한 경우
aedes.on('unsubscribe', function (subscriptions, client) {
  console.log('MQTT client: ' + client.id + " unsubscribe topic: " + subscriptions.map(s => s.topic).join('\n'));
 })

/*aedes.authorizePublish = function (client, packet, callback) {
  packet.payload = Buffer.from('overwrite packet payload');
  callback(null)
};*/

// client가 메시지 게시한 경우 
aedes.on('publish', async function (packet, client) {    
  if(packet.topic.includes('charRoomCreAndDel')){
    console.log("payload: " + packet.payload.toString());
  }

  // chat컬렉션에 메시지 저장
  if(client != null && packet.topic.includes('/topics')){
      const payloadStr = packet.payload.toString();

      console.log("payload: " + payloadStr);

      const chatItemValArr = payloadStr.split(chatDivisionVal);

      let profileImageURL = chatItemValArr[0];
      
      console.log("profileImageURL: " + profileImageURL);

      let chatRoomId = chatItemValArr[1];
      let chatUserId = chatItemValArr[2];
      let chatText = chatItemValArr[3];
      let chatFileUrl = chatItemValArr[4];
      let chatDate = chatItemValArr[5];
      let chatTime = chatItemValArr[6];
      let chatUserNickName = chatItemValArr[7];
      let chatId = chatItemValArr[8];
      let chatType = chatItemValArr[9];
      let notReadUserCount = Number(chatItemValArr[10]);

      chatRoomId = packet.topic.split("/")[2];
      console.log("chatRoomId: " + chatRoomId);

      // 안읽은 사용자 수 업데이트
      if(chatType == "3") {
        MongoClient.connect(url, async function(err, db) {
          if (err) {
            throw err
          };

          lastId = Number(chatText);
          bubbly_chat = await db.db("bubbly_chat")
          chat = await bubbly_chat.collection("chat");
          lastId = lastId + 1;

          // chatRoomId: /topics/chatRoomId의 형태로 저장됨!
          // seq/packet.topic => seq/topics/chtroomid로 채팅방별로 구분됨!!!
          await chat.updateMany(
            {
              chatRoomId: chatRoomId,
              chatId: {$gte:lastId}
            },
            {
              $inc: {notReadUserCount: -1}	
            }, async () => {
              console.log("몽고db에 안읽은 사용자수 업데이트 완료!!");
              db.close();
            });
      });
    } else { // 텍스트, 이미지, 동영상 전송
      if(!chatText.includes("나갔습니다") && !chatText.includes("!!!!!!")){
        chatText = chatText.split("!!!!!!")[0];
      }
      
      MongoClient.connect(url, async function(err, db) {
        if (err) {
          throw err
        };
        bubbly_chat = await db.db("bubbly_chat")
        chat = await bubbly_chat.collection("chat");
        chatSeq = await bubbly_chat.collection("chatSeq");
  
        chatId = await getNextSequence(chatSeq, packet.topic);
        
        // 전체 참여자 - 현재 참여자
        console.log(chatRoomId + " all - " + userCountMap.get(Number(chatRoomId)));
        console.log(chatRoomId + " current - " + userCountMap.get(Number(chatRoomId))[1]);
        
        notReadUserCount = userCountMap.get(Number(chatRoomId))[0] - userCountMap.get(Number(chatRoomId))[1]; 
  
        // chatRoomId: /topics/chatRoomId의 형태로 저장됨!
        // seq/packet.topic => seq/topics/chtroomid로 채팅방별로 구분됨!!!
        await chat.insertOne(
          { 
            "profileImageURL" : profileImageURL,
            "chatRoomId" : chatRoomId,
            "chatUserId" : chatUserId,
            "chatText" : chatText,
            "chatFileUrl" : chatFileUrl,
            "chatDate" : chatDate,
            "chatTime" : chatTime,
            "chatUserNickName" : chatUserNickName,
            "chatId" : chatId,
            "chatType" : chatType,
            "notReadUserCount" : notReadUserCount
          }, async () => {
            console.log("몽고db에 채팅메시지 저장완료!!");
            db.close();
  
            // 메시지 아이디와 안읽은 사용자수를 가지고 있는 메시지를 만든다
            let msg = profileImageURL + chatDivisionVal
            + chatRoomId + chatDivisionVal
            + chatUserId + chatDivisionVal
            + chatText + chatDivisionVal
            + chatFileUrl + chatDivisionVal
            + chatDate + chatDivisionVal
            + chatTime + chatDivisionVal
            + chatUserNickName + chatDivisionVal
            + chatId + chatDivisionVal
            + chatType + chatDivisionVal
            + notReadUserCount;
  
            console.log("새로 만든 메시지: " + msg);
  
            var packet2 = {
              topic: packet.topic,
              
              payload: msg,
              
              qos: 2,
              retain: false,  
            };
  
            await aedes.publish(packet2, function() {
              console.log('MQTT broker message sent');
            });
  
            if(!chatText.includes("나갔습니다") && !chatText.includes("!!!!!!")){
              // FCM 알림 전송
              if(profileImageURL == "null"){
                profileImageURL = cloudFrontAddr + "profile.png";
              } else {
                profileImageURL = cloudFrontAddr + profileImageURL;
              }
            
              console.log("profileImageURL: " + profileImageURL);
              
              broadcastFCMMessage(chatRoomId, chatUserNickName, chatText, profileImageURL);
              
              
              // db 업데이트 => 채팅방의 최신메시지, 최신 메시지 저장 시간, 메시지시퀀스 업데이트!!
              let queryStr = 'update chat_room set latest_msg = ? , latest_msg_time = ?, latest_msg_id = ? where chat_room_id = ?'
              let datas = [chatText, time.timeToKr(), chatId, chatRoomId];
  
              // 바이너리 채팅데이터 저장
              await maria.query(queryStr, datas, function(err, rows, fields){
                  if(!err){
                    console.log("채팅방 테이블에 최신 메시지 갱신 완료!!");
                  } else {
                      console.log(err);
                      console.log("db에 최신 메시지 저장 실패");
                  }
              });
            }
          });
      });
    } 
  }
})

// 새로운 사용자가 브로커와 연결한 경우 기존 채팅방을 조회해서 구독해준다.
aedes.on('client', async function (client) {
  const clientId = client.id;
  
  console.log("clientId: " + clientId);
});

// 사용자가 브로커와 연결 해제한 경우 
aedes.on('clientDisconnect', async function (client) {
  const clientId = client.id;
  
  console.log("clientDisconnect: " + clientId);
});


// form데이터와 multipart를 처리하기 위해 사용
app.use(busboy());
app.use(express.json());

// 데이터 조회
app.get("/selectChatData", async function(req,res) {
  const chatRoomId = req.param("chat_room_id");
  const pageNo = Number(req.param("page_no"));
  const pagingSize = Number(req.param("paging_size"));
  
  console.log("chatRoomId: " + chatRoomId);
  console.log("pageNo: " + pageNo);
  console.log("pagingSize: " + pagingSize);

  MongoClient.connect(url, function(err, db) {
    if (err) {
      throw err
    };

    chat = db.db("bubbly_chat").collection("chat");

    chat.find({"chatRoomId" : chatRoomId}).sort({"chatId" : -1}).skip((pageNo -1) * pagingSize).limit(pagingSize).toArray(function(err, result) {
      console.log(result);

      if (err) throw err;

      res.send(result);
  
      db.close();
  
    });
  });
});

// 사용자 아이디로 MQTT아이디 조회
app.get("/selectMqttClientUsingUserId", async function(req,res) {
  const userId = req.param("user_id")

  console.log(" 잘 들어옴! userId: " + userId);
  
  // user_id로 mqtt_client 조회
  let queryStr = 'select mqtt_client from user_info where user_id = ?'
  let datas = [userId];

  // mqtt_client 정보가 있다면 클라이언트에게 전송
  await maria.query(queryStr, datas, function(err, rows, fields){
    if(!err){
      console.log("성공");
      
      const mqtt_client = rows[0].mqtt_client;
      
      console.log("mqtt_client: " + mqtt_client);

      // mqttClient가 존재한다면 클라이언트에게 전송
      if(mqtt_client != null){
        res.send(mqtt_client);
      } else {
        res.send("not exist");
      }
    } else {
      console.log(err);
      console.log("실패");
      res.send("fail");
    }
  });
});

// mqtt_client 저장
app.post("/insertMqttClientId", async function(req,res) {
  await parseFormData(req);

  // 암호화된 비밀번호 생성
  const mqttClient = hashmap.get("mqtt_client");
  const userId = hashmap.get("user_id");

  // 데이터베이스에 커뮤니티 정보를 저장한다.
  let queryStr = 'update user_info set mqtt_client = ? where user_id = ?';
  let datas = [mqttClient, userId];

  // 저장!
  await maria.query(queryStr, datas, function(err, rows, fields){
      if(!err){
          console.log("성공");
          res.send("success");
      } else {
          console.log(err);
          console.log("실패");
          res.send("fail");
      }
  });
});

/**
 * 토큰정보 갱신 - 로그인 할 때마다 수행한다.
*/
app.post("/refreshToken", async function(req,res) {
  await parseFormData(req);

  const token = hashmap.get("token");
  const userId = hashmap.get("user_id");

  // 해당 함수에 잘들어오는지 확인
  console.log("refreshToken들어옴" + "token: " + token, " user_id: " + userId);

  // fcm_token 테이블에서 토큰정보를 조회한다.
  let queryStr = 'select token from fcm_token where token = ? and user_id = ?';
  let datas = [token, userId];

  // 저장!
  await maria.query(queryStr, datas, async function(err, rows, fields){
      if(!err){
          // 해당 토큰과 아이디에 대한 정보가 존재한다면
          if(rows[0] != undefined){
            const token1 = rows[0].token;

          // db에 user_id와 token이 동일한 데이터 있음
          console.log("db에 user_id와 token이 동일한 데이터 있음" + "token1: " + token1, " user_id: " + userId); 

            // 토큰의 갱신시간만 업데이트 해준다.
            let queryStr = 'update fcm_token set upd_datetime_token = ? where token = ? and user_id = ?';
            let datas = [time.timeToKr(), token1, userId];

            // 토큰의 갱신시간만 업데이트 해준다.
            await maria.query(queryStr, datas, async function(err, rows, fields){
                if(!err){
                    // db에 user_id와 token이 동일한 데이터 있음
                    console.log("토큰의 갱신시간만 업데이트 해준다." + "token1: " + token1, " user_id: " + userId); 
                    res.send("success");
                } else {
                    console.log(err);
                    console.log("실패");
                    res.send("fail");
                }
            });
          } else {// 해당 토큰과 아이디에 대한 정보가 존재하지 않는다면
            // user_id에 해당하는 데이터가 있는지 확인한다 => 다른 디바이스에 동잏한 로그인아이디로 등록이 되어있다면 
            // 그 디바이스와 연결된 구독정보를 해지한다.  
            let queryStr1 = 'select token from fcm_token where user_id = ?';
            let datas1 = [userId];

            // 조회
            await maria.query(queryStr1, datas1, async function(err, rows, fields){
                if(!err){
                  // 동일한 로그인아이디가 다른 디바이스에 등록되어있다면
                  if(rows[0] != undefined){
                    const token2 = rows[0].token;

                    // db에 user_id가 동일한 데이터 있음 ⇒ 다른 기기에서 로그인되어있는 상태
                    console.log("다른 기기에서 로그인되어있는 상태" + "token2: " + token2, " user_id: " + userId); 
                    
                    // 기존 토큰이 구독하고 있는 모든 채팅방 구독해지
                    await unSubscribeChatRoomToFCMServer(token2, userId,res);
                    // 기존 토큰 삭제
                    await deleteFCMToken(token2, res);
                    await deleteFCMToken(token, res);

                    // 새로운 토큰 정보 저장
                    await insertToken(userId, token, res)
                  } else {
                    // 해당 디바이스를 사용하는 다른 사용자가 있는지 확인한다.
                    let queryStr1 = 'select token, user_id from fcm_token where token = ?';
                    let datas1 = [token];
        
                    // 조회
                    await maria.query(queryStr1, datas1, async function(err, rows, fields){
                        if(!err){
                          // 해당 디바이스에 다른 기기가 등록되어 있다면
                          if(rows[0] != undefined){
                            const userId2 = rows[0].user_id;
        
                            // db에 user_id가 동일한 데이터 있음 ⇒ 다른 기기에서 로그인되어있는 상태
                            console.log("해당 기기에 다른 아이디가 로그인되어있는 상태" + "token2: " + token, " user_id: " + userId2); 
                            
                            // 기존 토큰과 사용자가 구독하고 있는 모든 채팅방 구독해지
                            await unSubscribeChatRoomToFCMServer(token, userId2,res);
                            // 기존 토큰 삭제
                            await deleteFCMToken(token, res);
        
                            // 새로운 토큰 정보 저장
                            await insertToken(userId, token, res)
                          } else { // 최초 로그인이이라면
                            
                            // 토큰 정보 저장
                            await insertToken(userId, token, res)
                          }
                        } else {
                            console.log(err);
                            console.log("실패");
                            res.send("fail");
                        }
                      });
                  }
                  res.send(token);
                } else {
                    console.log(err);
                    console.log("실패");
                    res.send("fail");
                }
            });
          }
      } else {
          console.log(err);
          console.log("실패");
          res.send("fail");
      }
  });
});

// 토큰 등록
app.post("/insertToken", async function(req,res) {
  await parseFormData(req);

  // 암호화된 비밀번호 생성
  const token = hashmap.get("token");
  const userId = hashmap.get("user_id");

  // 데이터베이스에 fcm토큰 정보를 저장한다.
  let queryStr = 'insert into fcm_token (token, user_id, cre_datetime_token) values (?)';
  let datas = [token, userId, time.timeToKr()];

  // 저장!
  await maria.query(queryStr, [datas], async function(err, rows, fields){
      if(!err){
          console.log("성공");
          res.send("success");
      } else {
          console.log(err);
          console.log("실패");
          res.send("fail");
      }
  });
});

/* 채팅방 구독(FCM)
  - 하나의 사용자가 채팅방을 구독한다 => 채팅방 입장 시
  - 입력: 사용자 아이디, 토큰, 채팅방id
*/
app.post("/subscribeChatRoom", async function(req,res) {
  await parseFormData(req);

  const token = hashmap.get("token");
  const chatRoomId = hashmap.get("chat_room_id");

  let topic = "/topics/" + chatRoomId;

  // These registration tokens come from the client FCM SDKs.
  const registrationTokens = [token];

  // Subscribe the devices corresponding to the registration tokens to the
  // topic.
  admin.messaging().subscribeToTopic(registrationTokens, topic)
    .then((response) => {
      // See the MessagingTopicManagementResponse reference documentation
      // for the contents of response.
      console.log('Successfully subscribed to topic:', response);
      res.send("success");
    })
    .catch((error) => {
      console.log('Error subscribing to topic:', error);
      res.send("fail");
    });
});

/* 채팅방 구독 해제(FCM)
  - 하나의 사용자가 채팅방 구독을 해제한다.
  - 입력: 토큰, 채팅방id
*/
app.post("/unsubscribeChatRoom", async function(req,res) {
  await parseFormData(req);

  const token = hashmap.get("token");
  const chatRoomId = hashmap.get("chat_room_id");

  let topic = "/topics/" + chatRoomId;

  // These registration tokens come from the client FCM SDKs.
  const registrationTokens = [token];

  // Unsubscribe the devices corresponding to the registration tokens from
  // the topic.
  admin.messaging().unsubscribeFromTopic(registrationTokens, topic)
    .then((response) => {
      // See the MessagingTopicManagementResponse reference documentation
      // for the contents of response.
      console.log('Successfully unsubscribed from topic:', response);
      res.send("success");
    })
    .catch((error) => {
      console.log('Error unsubscribing from topic:', error);
      res.send("fail");
    });
});

/* 로그아웃
  - 로그아웃 시 FCM서버에 연결되어있는 해당 사용자의 모든 구독정보를 해지하고 db에 저장된 토큰정보를 삭제한다.
  - 입력: 토큰, 채팅방id
*/
app.post("/logout", async function(req,res) {
  await parseFormData(req);

  const token = hashmap.get("token");
  const userId = hashmap.get("user_id");

  // 구독하고 있는 모든 채팅방 구독해지
  await unSubscribeChatRoomToFCMServer(token, userId);
  // 토큰 삭제
  await deleteFCMToken(token);
  
  res.send("logout success")
});

/* 새로 생성된 채팅방의 모든 인원들 FCM 서버에게 구독요청
*/
app.post("/subscribeChatMemberToFCMServer", async function(req,res) {
  const body = req.body;

  const topic = body["topic"];
  console.log("topic: " + topic);

  const tokenList = body["tokenList"];
  console.log("tokenList: " + tokenList[0]);

  await subscribeChatMemberToFCMServer(tokenList,topic,res);
  });

/* 새로 생성되고 바로 파괴된 채팅방의 모든 인원들 FCM 서버에게 구독 해지요청
*/
app.post("/unsubscribeChatMemberToFCMServer", async function(req,res) {
  const body = req.body;

  const topic = body["topic"];
  console.log("topic: " + topic);

  const tokenList = body["tokenList"];
  console.log("tokenList: " + tokenList[0]);

  await unsubscribeChatMemberToFCMServer(tokenList,topic,res);
  
  res.send("success")
});


// 채팅방 입장, 나가기 시 사용자맵 데이터 갱신
app.post("/updateUserCountMap", async function(req,res) {
  await parseFormData(req);

  // 채팅방 아이디
  const chatRoomId = Number(hashmap.get("chat_room_id"));

  console.log("chatRoomId: " + chatRoomId);

  // 채팅방 사용자 맵 갱신 구분값 (0:입장, 1: 나가기(뒤로가기), 2: 채팅방 삭제(영구적으로 나가기)), 3: 새로운 채팅방 생성
  const updateDiv = Number(hashmap.get("update_div"));
  
  const newAllUserCount = Number(hashmap.get("all_userCount"));

  // 문자열로 사용할 것!
  const userId = hashmap.get("user_id");

  let allUserCount;
  let currentUserCount;

  // 채팅방 입장, 나가기, 영구나가기 시
  if(updateDiv != 3){
    allUserCount = userCountMap.get(chatRoomId)[0];
    // 해당 채팅방의 현재 채팅 참여자 수
    currentUserCount = userCountMap.get(chatRoomId)[1];
  }
        
  // 해당 채팅방의 현재 사용자아이디 리스트
  let currentChatUserList = currentChatUserIdListap.get(chatRoomId);

  if(currentChatUserList != null && currentChatUserList != undefined){
    console.log("현재 채팅방의 참여자 리스트: " + currentChatUserList.length);
  }

  // 채팅방에 입장 혹은 나가기를 요청한 사용자가 있는지 확인
  let isUserExist = false;

  // 현재사용자가 리스트에 저장되어있는 위치
  let currentUserPost;

  // 현재 채팅에 참여한 사용자가 있다면  
  if(currentChatUserList != null && currentChatUserList != undefined){
    for(let i = 0; i < currentChatUserList.length; i++ ){
      if(currentChatUserList[i] == userId) {
        isUserExist = true;
        currentUserPost = i;
        break;
      }
    }
  }

  console.log("isUserExist: " + isUserExist + " currentUserPost: " + currentUserPost);
  
  // 채팅방에 입장 시
  if(updateDiv == 0){
    console.log("채팅방 입장 맵 갱신");

    // 채팅방에 해당 사용자가 존재하지 않는다면
    if(!isUserExist){
      // 새로 생성 시!
      if(currentChatUserList == undefined){
        currentChatUserList = [];
      }

      console.log("사용자 입장 시 리스트 갱신전 사용자수: " + currentChatUserList.length);

      // 사용자아이디리스트에 사용자 추가
      currentChatUserList.push(userId);

      console.log("사용자 입장 시 리스트 갱신 후 사용자수: " + currentChatUserList.length);

      // 사용자아이디리스트 맵에 사용자 추가
      currentChatUserIdListap.set(chatRoomId, currentChatUserList);

      // 해당 채팅방 채팅참여자 수 1증가
      currentUserCount++;
    } else {
      console.log("왜 여기로 들어옴?: " + currentChatUserList.length);
    }

    console.log("채팅방 입장 맵 갱신22");

    
  } else if(updateDiv == 1){ // 채팅방 나갔을 때(뒤로가기)
    console.log("채팅방 나가기 맵 갱신");

    // 채팅방에 해당 사용자가 존재 한다면
    if(isUserExist){
      console.log("사용자 나가기 시 리스트 갱신전 사용자수: " + currentChatUserList.length);

      // 사용자아이디리스트의 특정 위치에 있는 사용자 1명 삭제
      currentChatUserList.splice(currentUserPost,1);

      console.log("사용자 나가기 후 리스트 갱신전 사용자수: " + currentChatUserList.length);

      // 사용자아이디리스트 맵에 사용자 삭제
      currentChatUserIdListap.set(chatRoomId, currentChatUserList);
      
      // 해당 채팅방 채팅참여자 수 1증가
      currentUserCount--;
    }
  } else if(updateDiv == 2){ // 채팅방 영구적으로 나가기
    allUserCount--;
  } else { // 채팅방 새로 생성 => 현재 사용자 = 1
    // 현재 채팅방 사용자 맵에 새로운 채팅방과 생성자id 추가
    currentChatUserIdListap.set(chatRoomId, [userId]);

    allUserCount = newAllUserCount;
    currentUserCount = 1;
  }

  if(userCountMap.get(chatRoomId) != undefined){
    console.log("채팅방 현재 참여자 갱신 전" + chatRoomId + " - " + userCountMap.get(chatRoomId)[1]);
  }
  userCountMap.set(chatRoomId, [allUserCount, currentUserCount]);

  if(userCountMap.get(chatRoomId) != undefined){
    console.log("채팅방 현재 참여자 갱신 후" + chatRoomId + " - " +  userCountMap.get(chatRoomId)[1]);
  }

});

// 기존에 존재하는 채팅방인지 여부 조회
app.get('/selectExistingChatRoomId', async function(req,res) {
  const chatMember1 = req.query.chatMember1;  
  const chatMember2 = req.query.chatMember2;

  const membsers1 =chatMember1 + "," + chatMember2;
  const membsers2 =chatMember2 + "," + chatMember1;

  console.log("membsers1: " + membsers1);
  console.log("membsers2: " + membsers2);

  // 쿼리문
  let sql = " select chat_room_id "
          + " from ( "
              + " select chat_room_id, GROUP_CONCAT(user_id SEPARATOR ',') AS result  "
              + "       FROM chat_participant "
              + "       group by chat_room_id "
              + "       having count(*) = 2 "
              + "   ) a "
          + " where a.result = ? or a.result = ? ";

  const datas = [membsers1, membsers2];

  console.log(sql);

  await maria.query(sql, datas, function (err, rows) {
      if (err) {
          console.log(err);
          throw err;
      } else {
          if(rows[0] != undefined){
              const chatRoomId = rows[0].chat_room_id;
              console.log(rows);
              res.send("" + chatRoomId);
          } else {
              res.send("null");
          }
          
      }
  });
});

// db에 FCM 토큰 저장
async function insertToken(userId, token, res){
    let queryStr = 'insert into fcm_token (token, user_id, cre_datetime_token) values (?)';
    let datas = [token, userId, time.timeToKr()];
  
    // 저장!
    await maria.query(queryStr, [datas], async function(err, rows, fields){
        if(!err){
            // 데이터베이스에 fcm토큰 정보를 저장한다.
            console.log("데이터베이스에 fcm토큰 정보를 저장한다." + " token: " + token + " userId: " + userId); 
            
            // 해당 토큰과 user_id에 해당하는 데이터가 존재하지 않는경우 채팅방 정보를 조회해서 fcm서버에 구독해준다.
            subscribeChatRoomToFCMServer(token, userId, res);
        } else {
            console.log(err);
            console.log("실패");
        }
    });
  }
  

// db에서 FCM 토큰 삭제
async function deleteFCMToken(token, res){
  let queryStr = 'delete from fcm_token where token = ?';
  let datas = [token];

  // 저장!
  await maria.query(queryStr, datas, async function(err, rows, fields){
      if(!err){
          // db에서 FCM 토큰 삭제
          console.log("db에서 FCM 토큰 삭제"); 
      } else {
          console.log(err);
          // db에서 FCM 토큰 삭제
          console.log("db에서 FCM 토큰 삭제 실패"); 
          res.send(err);
      }
  });
}

/* 새로운 토큰을 발급했을 때 기존 채팅방을 구독하는 함수
  - 입력된 토큰에 모든 채팅방을 구독하게 한다.
  - 입력: 토큰, 채팅방id
*/
async function subscribeChatRoomToFCMServer(token, user_id, res){
  let count = 0;
  // These registration tokens come from the client FCM SDKs.
  const registrationTokens = [token];

  // 데이터베이스에서 해당 사용자가 참여하고 있는 채팅방 목록을 조회한다.
  let queryStr = 'select chat_room_id from chat_participant where user_id = ?';
  let datas = [user_id];

  // 저장!
  await maria.query(queryStr, datas, async function(err, rows, fields){
      if(!err){
        let size = rows.length;

        // 데이터베이스에서 해당 사용자가 참여하고 있는 채팅방 목록을 조회
        console.log("데이터베이스에서 해당 사용자가 참여하고 있는 채팅방 목록을 조회" + " size: " + size); 

        // row의 갯수만큼 반복
        for(let i = 0; i < size; i++){
          let topic = "/topics/" + rows[i].chat_room_id;
          
          console.log("topic: " + topic);

          // topic.
          admin.messaging().subscribeToTopic(registrationTokens, topic)
          .then((response) => {
            // See the MessagingTopicManagementResponse reference documentation
            // for the contents of response.
            console.log('Successfully subscribed to topic:', topic);
          })
          .catch((error) => {
            console.log('Error subscribing to topic:', error);
          });
        }
      } else {
          console.log(err);
          console.log("실패");
          res.send(err);
      }
  });
}

/* 새로운 채팅방 생성 시 채팅방에 있는 사용자들을 FCM에게 구독 요청
  - 모든 사용자를 등록한다.
  - 입력: 토큰 리스트, "/topics/채팅방id"
*/
async function subscribeChatMemberToFCMServer(tokenList, topic, res){
  // 특정 채팅방에 들어가있는 사용자들의 FCM 토큰 리스트
  const registrationTokens = tokenList;

  console.log("registrationTokens.length: " + registrationTokens.length);

  // topic.
  admin.messaging().subscribeToTopic(registrationTokens, topic)
  .then((response) => {
    // See the MessagingTopicManagementResponse reference documentation
    // for the contents of response.
    console.log('Successfully subscribed to topic:', topic);
    res.send("success");
  })
  .catch((error) => {
    console.log('Error subscribing to topic:', error);
    res.send(error);
  });

}

/* 새로운 채팅방 생성 후 바로 파괴 시 채팅방에 있는 사용자들을 FCM에게 구독 해지 요청
  - 모든 사용자를 구독 해지한다.
  - 입력: 토큰 리스트, "/topics/채팅방id"
*/
async function unsubscribeChatMemberToFCMServer(tokenList, topic, res){
  // 특정 채팅방에 들어가있는 사용자들의 FCM 토큰 리스트
  const registrationTokens = tokenList;

  console.log("registrationTokens.length: " + registrationTokens.length);

  // topic.
  admin.messaging().unsubscribeFromTopic(registrationTokens, topic)
  .then((response) => {
    console.log('Successfully unsubscribed to topic:', topic);
  })
  .catch((error) => {
    console.log('Error unsubscribing to topic:', error);
    res.send(error);
  });

}

/* 기존에 등록된 사용자가 로그아웃 했을 때 FCM 서버에 구독하고 있던 채팅방 목록을 구독해지 요청
  - 입력된 토큰의 모든 채팅방을 구독해지 한다.
  - 입력: 토큰, 채팅방id
*/
async function unSubscribeChatRoomToFCMServer(token, user_id, res){
  // These registration tokens come from the client FCM SDKs.
  const registrationTokens = [token];

  // 데이터베이스에 채팅방 정보를 저장한다.
  let queryStr = 'select chat_room_id from chat_participant where user_id = ?';
  let datas = [user_id];

  // 저장!
  await maria.query(queryStr, datas, async function(err, rows, fields){
      if(!err){
        let count = 0;
        let size = rows.length;

        // 해당 사용자가 구독하고 있는 채팅방 목록
        console.log("해당 사용자가 구독하고 있는 채팅방 목록 사이즈" + "size: " + size); 

          // row의 갯수만큼 반복
          for(let i = 0; i < size; i++){
            let topic = "/topics/" + rows[i].chat_room_id;
            
            // topic.
            admin.messaging().unsubscribeFromTopic(registrationTokens, topic)
            .then((response) => {
              // See the MessagingTopicManagementResponse reference documentation
              // for the contents of response.
              console.log('Successfully unsubscribed to topic:', topic);
            })
            .catch((error) => {
              console.log('Error unsubscribing to topic:', error);
            });
          }
      } else {
          console.log(err);
          console.log("실패");
          res.send(err);
      }
  });
}

// fcm 메시지 전송
function broadcastFCMMessage(chatRoomId, userName, msg, profileImageURL){
  let topic = '/topics/' + chatRoomId;

  const message = {
    notification: {
      title: userName,
      body: msg
    },
    data : {
      title: userName,
      chatRoomId : chatRoomId,
      body: msg
    },
    android: {
      priority: "high",
      notification: {
        icon: "skeleton",
        //imageUrl: profileImageURL,
        click_action: 'FCM_NOTI_ACTIVITY'
      }
    },
    topic: topic
  };

  // Send a message to devices subscribed to the provided topic.
  admin.messaging().send(message)
    .then((response) => {
      // Response is a message ID .
      console.log('Successfully sent message:', response);
    })
    .catch((error) => {
      console.log('Error sending message:', error);
    });
}

/* form 데이터를 파싱한다(텍스트만 있다).
    input: req
    output: hashMap <= 필드데이터가 key, value로 저장되어있음
*/
function parseFormData(req){
  return new Promise( (resolve)=>{
      // 필드정보를 저장할 해시맵
      hashmap = new HashMap();

      // 데이터 스트림 만듬
      req.pipe(req.busboy);

      //텍스트 정보를 읽어와 맵에 저장.
      req.busboy.on('field',(name, value, info) => {
          hashmap.set(name, value);
          console.log("value: " + name , hashmap.get(name));
      });

      req.busboy.on("finish", function() {
          return resolve();            
      });
  })
}

// 채팅 시퀀스 관리 함수
async function getNextSequence(chatSeq, name) {
  let returnVal = await chatSeq.findOneAndUpdate(
      { name: name },
      {
        $inc: {
            seq: 1
        }
      },
      {
        upsert:true,
        new: true
      }
    );

  if(returnVal.value == null) {
    returnVal = await chatSeq.findOneAndUpdate(
      { name: name },
      {
        $inc: {
            seq: 1
        }
      },
      {
        upsert:true,
        new: true
      }
    );

    return returnVal.value.seq;
  } else{
    return returnVal.value.seq;
  }
}

// 채팅서버 시작 시 각 채팅방의 전체참여인원과 현재 참여인원 초기화
async function initUserCountMap(){
    // 쿼리문
    let sql = " select cr.chat_room_id "
    + "      , (select count(chat_room_id) from chat_participant where chat_room_id = cr.chat_room_id) member_count "
    + " from chat_room cr "
    + " where cr.latest_msg is not null"

  await maria.query(sql, function (err, rows) {
  if (err) {
    console.log(sql);
    throw err;
  } else {
    console.log("initUserCountMap 성공");
    
    for(let i = 0; i < rows.length; i ++ ) {
      const chatRoomId = rows[i].chat_room_id;
      const memberCount = rows[i].member_count;

      // 채팅방 id와 [전체 사용자수, 현재사용자수] 초기화
      userCountMap.set(chatRoomId,[memberCount,0]);
    }
  }
  });
}

// 브로커 서버 실행
server.listen(portMqtt, function () {
  console.log('server started and listening on port ', portMqtt)
})

// express 서버 실행
app.listen(port2, () => {
  console.log('Example app listening on port ',  port2)
});

// https 서버 실행
https.createServer(options, app).listen(443, () => {
  console.log('bubbly listening at port 443');
});

/* https 적용!
http
  .createServer((req, res) => {
    res.writeHead(301, {
      Location: "https://" + req.headers["host"] + req.url,
    });
    res.end();
  })
  // Ubuntu 배포 환경 .env 파일에서는 PORT가 80으로 설정되어 있습니다.
  .listen(80, () => {
    // DUZZLE listening at port 80
    console.log('bubbly listening at port 80');
  });
  */
